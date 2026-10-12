import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { sessionTitle } from '../api/user-text.js';
import type { Db } from '../db/index.js';
import {
  type LiveDriver,
  type LiveEnvironment,
  liveEvents,
  type LiveProcessKind,
  liveProcesses,
  liveSessions,
  runs,
  sessions,
  subagents,
  userMessages,
  variants as variantsTable,
  workflowDrafts,
} from '../db/schema.js';
import { events } from '../events.js';
import { createRunTicket } from '../external/linear.js';
import type { RunRepos } from '../external/run-repos.js';
import { ingestFile } from '../ingest/ingest.js';
import { newId } from '../runs/index.js';
import type { SettingsStore } from '../runs/settings.js';
import type { EvalFacts, SimulatedPersona } from '../runs/simulated-user.js';
import { ensureImportedBundle, previewLinearImport } from '../tasks/linear-import.js';
import { loadTask, withRepo, withTicket } from '../tasks/loader.js';
import type { Task } from '../tasks/schema.js';
import { type CodexSources, writeCodexHome } from '../variants/codex-home.js';
import { HttpError } from '../variants/errors.js';
import type { Variants } from '../variants/index.js';
import { entryOf, evalSpec } from '../workflows/eval-kinds.js';
import { evalSpecOf, workflowOfVariant, workflowRow } from '../workflows/index.js';
import type { EvalSpec } from '../workflows/schema.js';
import {
  CodexRunner,
  codexConfigExtra,
  codexDirsOf,
  codexResumeArgs,
  codexStartArgs,
  rolloutFiles,
  waitForSession,
} from './codex.js';
import { type HandBackReason, type HookPayload, LiveController } from './controller.js';
import { LivePty } from './pty.js';
import {
  type CreateLiveBody,
  type LiveDetail,
  type LiveEventView,
  type LiveProcessView,
  type LiveSummary,
  type ResumeDefaults,
  type ResumeLiveBody,
  TITLE_MAX,
} from './views.js';

export interface LiveDeps {
  db: Db;
  variants: Variants;
  settings: SettingsStore;
  vaultDir: string;
  product: string;
  // data/live
  liveDir: string;
  // variant 所在的数据目录（session 绑定 variant 时读 skill）
  dataDir: string;
  // hook 命令 POST 的地址：服务实际监听的 http://host:port
  serverUrl: () => string;
  // "本机配置"的 HOME（claude 读 <home>/.claude）；测试用 .work/ 下的目录
  localHome: string;
  // isolated 交互的副本仓库建在 GitHub 或本地仓库模式的目录中（Contracts 7.2、14.2）
  repos: RunRepos;
  // Codex 会话（Contracts 17.3）：运行的命令、认证与模型配置的来源、等待会话记录出现的时限
  codex: { bin: string; sources: CodexSources; sessionTimeoutMs: number };
}

export const LIVE_ID = /^l-\d{8}-[a-z0-9]{6}$/;

// 现场输入时模拟用户扮演的人（Contracts 14.4）
const INPUT_PERSONA = '提出这个想法（或工单）的人，只依据输入回答，没写到的按常理回答。';
const RESUME_PERSONA =
  '这个 session 中与 agent 对话的用户，只依据之前的对话回答，没写到的按常理回答。';

const HOOK_EVENTS = ['Stop', 'Notification', 'UserPromptSubmit', 'SessionStart'] as const;

// 新建的项的默认名字：输入的前 40 个字（Contracts 14.3）
const DEFAULT_TITLE_LENGTH = 40;

// 父进程是 Claude Code 或 Orca 时，这些变量会覆盖子进程的配置
function strippedEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !entry[0].startsWith('CLAUDE') &&
        !entry[0].startsWith('ANTHROPIC') &&
        !entry[0].startsWith('ORCA_AGENT'),
    ),
  );
}

// 改名的名字：去掉首尾空白后非空，最多 200 字；不满足时以原文报错
export function checkTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed === '') throw new HttpError(400, '名字不能为空');
  const length = Array.from(trimmed).length;
  if (length > TITLE_MAX) {
    throw new HttpError(400, `名字最多 ${String(TITLE_MAX)} 个字，现在是 ${String(length)} 个字`);
  }
  return trimmed;
}

// pty.log 中每个进程开始时的分隔行（Contracts 14.5）
function separatorLine(at: Date, kind: LiveProcessKind, variant: string): string {
  return `\r\n\u001b[2m──── ${at.toISOString()} · ${kind} · ${variant} ────\u001b[0m\r\n`;
}

interface Launch {
  liveId: string;
  kind: LiveProcessKind;
  variantId: string | null;
  // 新建交互与 resume 时选的模型与 effort（Contracts 16.5）；本机配置不传
  model: string;
  effort: string;
  environment: LiveEnvironment;
  cwd: string;
  claudeSessionId: string;
  // claude 的位置参数之前的参数：--session-id 与初始消息，或 --resume
  sessionArgs: string[];
  // <CLAUDE_CONFIG_DIR>/projects/ 下 session 所在的目录名（CLAUDE_CODE_PROJECT_DIR_NAME）
  projectDirName: string;
  driver: LiveDriver;
  persona: SimulatedPersona;
  eval: EvalFacts | null;
  extraEnv: Record<string, string>;
  start: Record<string, unknown>;
}

type ItemRow = typeof liveSessions.$inferSelect;
type ProcessRow = typeof liveProcesses.$inferSelect;

export function createLive(deps: LiveDeps) {
  const { db, variants, settings } = deps;
  const controllers = new Map<string, LiveController | CodexRunner>();

  // 上次服务退出时运行中的进程：PTY 进程随服务退出
  const interrupted = db
    .update(liveProcesses)
    .set({ status: 'exited', error: '服务重启中断', endedAt: new Date() })
    .where(eq(liveProcesses.status, 'running'))
    .returning({ liveId: liveProcesses.liveId })
    .all();
  for (const r of interrupted) events.publish({ type: 'live.updated', liveId: r.liveId });

  function row(id: string): ItemRow {
    const found = db.select().from(liveSessions).where(eq(liveSessions.id, id)).get();
    if (found === undefined) throw new HttpError(404, `交互不存在：${id}`);
    return found;
  }

  function processesOf(id: string): ProcessRow[] {
    return db
      .select()
      .from(liveProcesses)
      .where(eq(liveProcesses.liveId, id))
      .orderBy(asc(liveProcesses.id))
      .all();
  }

  // 最近的进程；从本机导入、还没有运行过的项为空
  function latestProcess(id: string): ProcessRow | null {
    return (
      db
        .select()
        .from(liveProcesses)
        .where(eq(liveProcesses.liveId, id))
        .orderBy(desc(liveProcesses.id))
        .get() ?? null
    );
  }

  function controllerOf(id: string): LiveController | CodexRunner {
    row(id);
    const controller = controllers.get(id);
    if (controller === undefined || latestProcess(id)?.status !== 'running') {
      throw new HttpError(409, `交互 ${id} 不在运行中`);
    }
    return controller;
  }

  // hook 与驾驶者只属于 Claude Code 的进程：Codex 会话只有人驾驶（Contracts 17.3）
  function claudeControllerOf(id: string): LiveController {
    const controller = controllerOf(id);
    if (controller instanceof CodexRunner) {
      throw new HttpError(409, `交互 ${id} 是 Codex 会话，只有人驾驶，没有 hook 与模拟用户`);
    }
    return controller;
  }

  function liveDir(id: string) {
    return path.join(deps.liveDir, id);
  }

  function variantName(variantId: string | null): string | null {
    if (variantId === null) return null;
    return (
      db
        .select({ name: variantsTable.name })
        .from(variantsTable)
        .where(eq(variantsTable.id, variantId))
        .get()?.name ?? null
    );
  }

  function processView(p: ProcessRow): LiveProcessView {
    return {
      id: p.id,
      kind: p.kind,
      variantId: p.variantId,
      variantName: variantName(p.variantId),
      pid: p.pid,
      status: p.status,
      exitCode: p.exitCode,
      error: p.error,
      driver: p.driver,
      startedAt: p.startedAt.getTime(),
      endedAt: p.endedAt === null ? null : p.endedAt.getTime(),
    };
  }

  // 第一个进程的 start 事件：isolated 环境建出的副本仓库与工单
  function startPayload(id: string): Record<string, unknown> {
    const start = db
      .select({ payload: liveEvents.payload })
      .from(liveEvents)
      .where(and(eq(liveEvents.liveId, id), eq(liveEvents.kind, 'start')))
      .orderBy(asc(liveEvents.id))
      .get();
    return start?.payload ?? {};
  }

  function summary(r: ItemRow): LiveSummary {
    const all = processesOf(r.id);
    const last = all.at(-1);
    const process = last === undefined ? null : processView(last);
    const start = startPayload(r.id);
    const controller = controllers.get(r.id);
    const draft = db
      .select({ id: workflowDrafts.id })
      .from(workflowDrafts)
      .where(eq(workflowDrafts.liveId, r.id))
      .get();
    return {
      id: r.id,
      title: r.title,
      claudeSessionId: r.claudeSessionId,
      engine: r.engine,
      draftId: draft?.id ?? null,
      environment: r.environment,
      workflow: r.workflow,
      input: r.input,
      taskId: r.taskId,
      cwd: r.cwd,
      process,
      variantId: process?.variantId ?? null,
      // Codex 会话没有 variant，显示 Codex
      variantName:
        process?.variantName ?? (r.engine === 'codex' && process !== null ? 'Codex' : null),
      status: process?.status ?? 'idle',
      driver: process?.driver ?? 'human',
      error: process?.error ?? null,
      resumeCount: all.filter((p) => p.kind === 'resume').length,
      starting: process?.status === 'running' && controller?.starting === true,
      repo: typeof start.repo === 'string' ? start.repo : null,
      ticket: typeof start.ticket === 'string' ? start.ticket : null,
      createdAt: r.createdAt.getTime(),
      updatedAt: r.updatedAt.getTime(),
      hiddenAt: r.hiddenAt === null ? null : r.hiddenAt.getTime(),
    };
  }

  function eventViews(id: string): LiveEventView[] {
    return db
      .select()
      .from(liveEvents)
      .where(eq(liveEvents.liveId, id))
      .orderBy(asc(liveEvents.id))
      .all()
      .map((e) => ({
        id: e.id,
        processId: e.processId,
        at: e.at.getTime(),
        kind: e.kind,
        payload: e.payload,
      }));
  }

  function detail(id: string): LiveDetail {
    const r = row(id);
    const base = summary(r);
    // 驾驶者的切换只看最近的进程
    const evs = eventViews(id);
    const lastDriver = evs.findLast(
      (e) => e.kind === 'driver' && e.processId !== null && e.processId === base.process?.id,
    );
    const reason = lastDriver?.payload.reason;
    const handedBack =
      base.driver === 'human' &&
      (reason === 'input' ||
        reason === 'done' ||
        reason === 'max-turns' ||
        reason === 'error' ||
        reason === 'manual')
        ? reason
        : null;
    const controller = controllers.get(id);
    return {
      ...base,
      waiting: base.status === 'running' && controller !== undefined ? controller.waiting : null,
      handedBack,
      processes: processesOf(id).map(processView),
      events: evs,
    };
  }

  // 只传 hooks，不改动 variant 或用户自己的设置文件（Contracts 14.2）
  function writeHooks(id: string): string {
    const url = `${deps.serverUrl()}/api/live/${id}/hook`;
    const command = `curl -sS --fail-with-body -m 10 -X POST -H 'content-type: application/json' --data-binary @- '${url}' > /dev/null`;
    const hook = { type: 'command', command };
    const file = path.join(liveDir(id), 'hooks.json');
    const settingsFile = {
      skipDangerousModePermissionPrompt: true,
      hooks: {
        ...Object.fromEntries(HOOK_EVENTS.map((name) => [name, [{ hooks: [hook] }]])),
        PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [hook] }],
      },
    };
    fs.writeFileSync(file, `${JSON.stringify(settingsFile, null, 2)}\n`);
    return file;
  }

  function configDirOf(variantId: string | null): string {
    return variantId === null
      ? path.join(deps.localHome, '.claude')
      : variants.runtimeEnv(variantId).env.CLAUDE_CONFIG_DIR;
  }

  function insertItem(values: {
    id: string;
    claudeSessionId: string;
    engine?: 'claude' | 'codex';
    title: string;
    environment: LiveEnvironment;
    workflow: string | null;
    input: string | null;
    taskId: string | null;
    cwd: string;
  }) {
    db.insert(liveSessions)
      .values({ ...values, updatedAt: new Date() })
      .run();
  }

  // 在一项上起一个进程：第一次启动或 resume；项本身由调用方先建好
  function launch(spec: Launch): LiveDetail {
    const dir = liveDir(spec.liveId);
    fs.mkdirSync(dir, { recursive: true });
    const hooksFile = writeHooks(spec.liveId);
    let env: Record<string, string>;
    let variantArgs: string[];
    // 实际传给 claude 的 --model 与 --effort；本机配置不传，为空
    let model: string | null = null;
    let effort: string | null = null;
    let sandboxProfile: string | null = null;
    if (spec.variantId === null) {
      // 本机配置：不设 CLAUDE_CONFIG_DIR，claude 用 <HOME>/.claude
      env = { ...strippedEnv(), HOME: deps.localHome };
      variantArgs = [];
    } else {
      variants.refreshAuthEnv(spec.variantId);
      // 工作目录的信任确认（Contracts 14.2）：variant 的配置目录中先记为已信任
      variants.trustDirectory(spec.variantId, spec.cwd);
      const runtime = variants.runtimeEnv(spec.variantId);
      env = { ...runtime.env };
      model = spec.model;
      effort = spec.effort;
      variantArgs = ['--model', model, '--effort', effort, ...runtime.claudeArgs];
      if (spec.environment === 'isolated') {
        sandboxProfile = variants.sandboxProfile(
          spec.variantId,
          spec.liveId,
          deps.liveDir,
          deps.repos.localDir === null ? null : (spec.eval?.repo ?? null),
        );
      }
    }
    env = {
      ...env,
      ...spec.extraEnv,
      CLAUDE_CODE_PROJECT_DIR_NAME: spec.projectDirName,
      COLORTERM: 'truecolor',
    };
    const args = [
      ...variantArgs,
      '--permission-mode',
      'bypassPermissions',
      '--settings',
      hooksFile,
      ...spec.sessionArgs,
    ];
    const jsonl = path.join(
      configDirOf(spec.variantId),
      'projects',
      spec.projectDirName,
      `${spec.claudeSessionId}.jsonl`,
    );
    const startedAt = new Date();
    const pty = new LivePty({
      file: sandboxProfile === null ? 'claude' : 'sandbox-exec',
      args: sandboxProfile === null ? args : ['-p', sandboxProfile, 'claude', ...args],
      cwd: spec.cwd,
      env,
      cols: 120,
      rows: 40,
      logFile: path.join(dir, 'pty.log'),
      separator: separatorLine(startedAt, spec.kind, variantName(spec.variantId) ?? '本机配置'),
    });
    const processId = db.$client.transaction(() => {
      const inserted = db
        .insert(liveProcesses)
        .values({
          liveId: spec.liveId,
          kind: spec.kind,
          variantId: spec.variantId,
          model,
          effort,
          pid: pty.pid,
          status: 'running',
          // 收到第一个 SessionStart 之前驾驶者固定为人（Contracts 14.2）
          driver: 'human',
          startedAt,
        })
        .returning({ id: liveProcesses.id })
        .get();
      db.insert(liveEvents)
        .values({
          liveId: spec.liveId,
          processId: inserted.id,
          at: startedAt,
          kind: spec.kind,
          payload: {
            ...spec.start,
            argv: ['claude', ...args],
            sandboxed: sandboxProfile !== null,
            configDir: spec.variantId === null ? null : env.CLAUDE_CONFIG_DIR,
            jsonl,
            initialDriver: spec.driver,
          },
        })
        .run();
      db.update(liveSessions)
        .set({ updatedAt: startedAt })
        .where(eq(liveSessions.id, spec.liveId))
        .run();
      return inserted.id;
    })();
    const controller = new LiveController({
      db,
      settings,
      liveId: spec.liveId,
      processId,
      pty,
      jsonl,
      initialDriver: spec.driver,
      persona: spec.persona,
      eval: spec.eval,
      variantId: spec.variantId,
      dataDir: deps.dataDir,
      cwd: spec.cwd,
    });
    controllers.set(spec.liveId, controller);
    void controller.exited.then(() => {
      if (controllers.get(spec.liveId) === controller) controllers.delete(spec.liveId);
    });
    events.publish({ type: 'live.updated', liveId: spec.liveId });
    return detail(spec.liveId);
  }

  // 模拟用户扮演的人；stage 为 workflow 的评测配置，没有评测类型的 workflow 为空（只按通用的结束条件判断）
  const taskPersona = (task: Task, stage: EvalSpec | null): SimulatedPersona => ({
    stage,
    persona: task.persona,
    hiddenRequirements: task.hiddenRequirements,
  });

  function personaOf(task: Task | null, stage: EvalSpec | null): SimulatedPersona {
    return task === null
      ? { stage, persona: INPUT_PERSONA, hiddenRequirements: '' }
      : taskPersona(task, stage);
  }

  // 有评测类型的 workflow 的评测配置；没有评测类型时为空
  function stageOfWorkflow(workflowId: string): EvalSpec | null {
    const workflow = workflowRow(db, workflowId);
    return workflow.evalKind === null ? null : evalSpec(workflow.evalKind, workflow.id);
  }

  // 新建与 resume 时没有选的模型与 effort 取设置的默认值（Contracts 16.5）
  function modelOf(body: { model?: string | undefined; effort?: string | undefined }) {
    const { agentModel, agentEffort } = settings.get();
    return { model: body.model ?? agentModel, effort: body.effort ?? agentEffort };
  }

  // Contracts 14.2、16.7：先选 workflow，再选它的 variant；初始消息为 /<workflow id> <问题>
  async function create(body: CreateLiveBody): Promise<LiveDetail> {
    const stage = stageOfWorkflow(body.workflow);
    const variant = variants.get(body.variantId);
    if (variant.workflowId !== body.workflow) {
      throw new HttpError(
        400,
        `variant ${variant.name} 属于 workflow ${variant.workflowId}，不是 ${body.workflow} 的 variant`,
      );
    }
    // 构建成功才有 runtimeEnv
    variants.runtimeEnv(body.variantId);
    const entry = entryOf(body.workflow);
    const liveId = newId('l');
    const sessionId = randomUUID();
    const dir = liveDir(liveId);
    let cwd: string;
    let initial = `${entry} ${body.input}`;
    let evalFacts: EvalFacts | null = null;
    let extraEnv: Record<string, string> = {};
    let start: Record<string, unknown> = {};
    if (body.environment === 'isolated') {
      if (body.cwd !== null) throw new HttpError(400, 'isolated 环境的工作目录由 dashboard 建立');
      fs.mkdirSync(dir, { recursive: true });
      cwd = path.join(dir, 'workspace');
      const signal = new AbortController().signal;
      // 进程本来就在 sandbox 中，Claude Code 不再询问是否信任工作目录
      extraEnv = { CLAUDE_CODE_SANDBOXED: '1', MAGI_VAULT: deps.vaultDir };
      if (stage === null) {
        // 没有评测类型：只建空的 workspace
        fs.mkdirSync(cwd, { recursive: true });
      } else if (stage.kind === 'lfg') {
        const repo = await deps.repos.createEmpty(liveId, signal);
        // wf obsidian 要求 product 目录已存在
        fs.mkdirSync(path.join(deps.vaultDir, `Project ${deps.product}`), { recursive: true });
        extraEnv.MAGI_PRODUCT = deps.product;
        initial = [
          initial,
          '',
          `Product: ${deps.product}`,
          `Feature slug: ${liveId}`,
          `Repository: ${repo.repo}`,
        ].join('\n');
        evalFacts = { runId: liveId, repo: repo.repo, ticket: null, product: deps.product };
        start = { repo: repo.repo, repoUrl: repo.url };
      } else {
        // 问题必须是 Linear 工单：按第 13 节读取工单、取起始仓库与 commit，建仓库副本与工单副本（副本不写来源）
        const preview = await previewLinearImport(
          { issue: body.input, criteria: false },
          settings.get().copyRunnerLabels,
        );
        const sourceDir = path.join(dir, 'source');
        await ensureImportedBundle(preview.task, sourceDir);
        const task: Task = { ...preview.task, dir: path.join(sourceDir, preview.task.id) };
        const repo = await deps.repos.createCopy(withRepo(task), liveId, signal);
        const ticket = await createRunTicket(withTicket(task), liveId);
        initial = `${entry} ${ticket.identifier}`;
        evalFacts = {
          runId: liveId,
          repo: repo.repo,
          ticket: ticket.identifier,
          product: deps.product,
        };
        start = {
          repo: repo.repo,
          repoUrl: repo.url,
          ticket: ticket.identifier,
          ticketUrl: ticket.url,
          source: preview.issue.identifier,
        };
      }
      if (evalFacts !== null) {
        if (evalFacts.repo === null) throw new Error(`交互 ${liveId} 没有建出仓库`);
        await deps.repos.clone(evalFacts.repo, cwd, signal);
      }
    } else {
      if (body.cwd === null) throw new HttpError(400, 'real 环境需要填写工作目录');
      cwd = path.resolve(body.cwd);
      if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
        throw new HttpError(400, `工作目录不存在：${cwd}`);
      }
    }
    // 默认名字：初始消息第一行（/lfg <想法>、/ic <工单>）的前 40 个字
    const firstLine = initial.split('\n')[0] ?? initial;
    insertItem({
      id: liveId,
      claudeSessionId: sessionId,
      title: Array.from(firstLine.trim()).slice(0, DEFAULT_TITLE_LENGTH).join(''),
      environment: body.environment,
      workflow: body.workflow,
      input: body.input,
      taskId: null,
      cwd,
    });
    return launch({
      liveId,
      kind: 'start',
      variantId: body.variantId,
      ...modelOf(body),
      environment: body.environment,
      cwd,
      claudeSessionId: sessionId,
      sessionArgs: ['--session-id', sessionId, initial],
      projectDirName: liveId,
      driver: body.driver,
      persona: personaOf(null, stage),
      eval: evalFacts,
      extraEnv,
      start: { ...start, initial },
    });
  }

  // Codex 会话的一个进程（Contracts 17.3）：第一次启动时等 Codex 写出会话记录、取得会话 id 后才建项；
  // resume 在同一项上接着同一个会话
  async function launchCodex(
    spec:
      | { kind: 'start'; cwd: string; prompt: string; title: string; workflow: string | null }
      | { kind: 'resume'; liveId: string },
  ): Promise<LiveDetail> {
    let liveId: string;
    let cwd: string;
    let args: string[];
    // resume 接着这一项的会话；第一次启动时由 Codex 写出的会话记录取得
    let knownSession: string | null;
    if (spec.kind === 'resume') {
      const item = row(spec.liveId);
      if (item.engine !== 'codex') throw new HttpError(400, `交互 ${item.id} 不是 Codex 会话`);
      if (controllers.has(item.id) || running(item.id)) {
        throw new HttpError(409, `交互 ${item.id} 有运行中的进程`);
      }
      liveId = item.id;
      cwd = item.cwd;
      args = codexResumeArgs(item.claudeSessionId);
      knownSession = item.claudeSessionId;
    } else {
      liveId = newId('l');
      cwd = spec.cwd;
      args = codexStartArgs(spec.prompt);
      knownSession = null;
    }
    const { codexHome, home } = codexDirsOf(cwd);
    const dir = liveDir(liveId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    // 每次启动前重写：认证与模型配置可能变了；Codex 自己写进 config.toml 的键随之丢弃，下次启动时重新生成
    const { model, effort } = writeCodexHome(codexHome, deps.codex.sources, codexConfigExtra(cwd));
    const env = {
      ...strippedEnv(),
      HOME: home,
      CODEX_HOME: codexHome,
      // npx 的缓存仍用用户自己的 ~/.npm
      npm_config_cache: path.join(os.homedir(), '.npm'),
      COLORTERM: 'truecolor',
    };
    const known = new Set(rolloutFiles(codexHome));
    const startedAt = new Date();
    const pty = new LivePty({
      file: deps.codex.bin,
      args,
      cwd,
      env,
      cols: 120,
      rows: 40,
      logFile: path.join(dir, 'pty.log'),
      separator: separatorLine(startedAt, spec.kind, 'Codex'),
    });
    const sessionId =
      knownSession ??
      (await waitForSession(pty, codexHome, cwd, known, deps.codex.sessionTimeoutMs));
    const processId = db.$client.transaction(() => {
      if (spec.kind === 'start') {
        insertItem({
          id: liveId,
          claudeSessionId: sessionId,
          engine: 'codex',
          title: Array.from(spec.title.trim()).slice(0, DEFAULT_TITLE_LENGTH).join(''),
          // Codex 自己的沙箱只允许写草稿目录
          environment: 'isolated',
          workflow: spec.workflow,
          input: spec.prompt,
          taskId: null,
          cwd,
        });
      } else {
        setHidden(liveId, false, { reason: 'resume' });
      }
      const inserted = db
        .insert(liveProcesses)
        .values({
          liveId,
          kind: spec.kind,
          variantId: null,
          model,
          effort,
          pid: pty.pid,
          status: 'running',
          driver: 'human',
          startedAt,
        })
        .returning({ id: liveProcesses.id })
        .get();
      db.insert(liveEvents)
        .values({
          liveId,
          processId: inserted.id,
          at: startedAt,
          kind: spec.kind,
          payload: { engine: 'codex', argv: [deps.codex.bin, ...args], codexHome, home, sessionId },
        })
        .run();
      db.update(liveSessions)
        .set({ updatedAt: startedAt })
        .where(eq(liveSessions.id, liveId))
        .run();
      return inserted.id;
    })();
    const runner = new CodexRunner(db, liveId, processId, pty);
    controllers.set(liveId, runner);
    void runner.exited.then(() => {
      if (controllers.get(liveId) === runner) controllers.delete(liveId);
    });
    events.publish({ type: 'live.updated', liveId });
    return detail(liveId);
  }

  // 目标配置的 projects/ 下这个 session 的 jsonl；没有时为空
  function locate(configDir: string, sessionId: string): string | null {
    const projects = path.join(configDir, 'projects');
    if (!fs.existsSync(projects)) return null;
    for (const entry of fs.readdirSync(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const file = path.join(projects, entry.name, `${sessionId}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
    return null;
  }

  // 被 resume 的 session 的模拟用户：run 的 session 用 run 的 task，交互的 session 用当时的 task 与 workflow
  function resumePersona(session: typeof sessions.$inferSelect, item: ItemRow | null) {
    if (session.runId !== null) {
      const run = db.select().from(runs).where(eq(runs.id, session.runId)).get();
      if (run !== undefined) {
        return taskPersona(
          loadTask(db, run.taskId),
          evalSpecOf(db, workflowOfVariant(db, run.variantId)),
        );
      }
    }
    if (item?.workflow != null) {
      const stage = stageOfWorkflow(item.workflow);
      return personaOf(item.taskId === null ? null : loadTask(db, item.taskId), stage);
    }
    return {
      stage: null,
      persona: RESUME_PERSONA,
      hiddenRequirements: '',
    } satisfies SimulatedPersona;
  }

  // 这个 session 所属的项（Contracts 14.5：live_sessions.claude_session_id 相同）
  function itemOfSession(sessionId: string): ItemRow | null {
    return (
      db.select().from(liveSessions).where(eq(liveSessions.claudeSessionId, sessionId)).get() ??
      null
    );
  }

  function running(id: string): boolean {
    return latestProcess(id)?.status === 'running';
  }

  // 从已有 session 开始的项的默认名字：该 session 在 Sessions 列表中的标题
  function sessionListTitle(sessionId: string): string {
    const first = db
      .select({ text: userMessages.text })
      .from(userMessages)
      .where(
        and(
          eq(userMessages.sessionId, sessionId),
          isNull(userMessages.agentId),
          eq(userMessages.kind, 'user'),
        ),
      )
      .orderBy(asc(userMessages.timestamp), asc(userMessages.id))
      .get();
    const title = first === undefined ? '' : sessionTitle(first.text);
    return title === '' ? `session ${sessionId.slice(0, 8)}` : title;
  }

  function resumeDefaults(sessionId: string): ResumeDefaults {
    const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (session === undefined) throw new HttpError(404, `session 不存在：${sessionId}`);
    const item = itemOfSession(sessionId);
    // 默认为 session 绑定的 variant（Contracts 15.1）；没有绑定时为本机配置
    return {
      sessionId,
      variantId: session.variantId,
      cwd: session.cwd,
      cwdExists: session.cwd !== null && fs.existsSync(session.cwd),
      liveId: item?.id ?? null,
      running: item !== null && running(item.id),
    };
  }

  // Contracts 14.5：环境固定为 real，工作目录为 session 记录的 cwd；session 已属于某一项时在这一项上接着运行，
  // 否则为它建一项
  function resume(body: ResumeLiveBody): LiveDetail {
    const session = db.select().from(sessions).where(eq(sessions.id, body.sessionId)).get();
    if (session === undefined) throw new HttpError(404, `session 不存在：${body.sessionId}`);
    if (session.cwd === null) throw new HttpError(400, `session ${session.id} 没有记录工作目录`);
    const cwd = session.cwd;
    if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new HttpError(400, `工作目录不存在：${cwd}`);
    }
    if (body.variantId !== null) variants.runtimeEnv(body.variantId);
    const item = itemOfSession(session.id);
    if (item !== null && (controllers.has(item.id) || running(item.id))) {
      throw new HttpError(409, `session ${session.id} 正在交互 ${item.id} 中运行`);
    }
    const liveId = item?.id ?? newId('l');
    const configDir = configDirOf(body.variantId);
    // 先读完原文件，复制后的字节与已导入的偏移量一致
    ingestFile(db, session.filePath);
    let jsonl = locate(configDir, session.id);
    let copied = false;
    if (jsonl === null) {
      jsonl = path.join(configDir, 'projects', liveId, `${session.id}.jsonl`);
      fs.mkdirSync(path.dirname(jsonl), { recursive: true });
      fs.copyFileSync(session.filePath, jsonl);
      const sessionDir = path.join(path.dirname(session.filePath), session.id);
      if (fs.existsSync(sessionDir)) {
        fs.cpSync(sessionDir, path.join(path.dirname(jsonl), session.id), { recursive: true });
      }
      copied = true;
    } else if (jsonl !== session.filePath) {
      throw new HttpError(
        409,
        `session ${session.id} 已从 ${session.filePath} 导入，目标配置中另有一份 ${jsonl}`,
      );
    }
    const target = jsonl;
    // 之后导入目标配置中的那份；原文件不动
    db.$client.transaction(() => {
      if (item === null) {
        insertItem({
          id: liveId,
          claudeSessionId: session.id,
          title: sessionListTitle(session.id),
          environment: 'real',
          workflow: null,
          input: null,
          taskId: null,
          cwd,
        });
      }
      // 从 Sessions 详情 resume 一个已关闭项的 session：这一项恢复显示（Contracts 14.5）
      if (item !== null) setHidden(item.id, false, { reason: 'resume' });
      if (copied) {
        const oldDir = path.join(path.dirname(session.filePath), session.id);
        const newDir = path.join(path.dirname(target), session.id);
        db.update(sessions).set({ filePath: target }).where(eq(sessions.id, session.id)).run();
        for (const sub of db
          .select()
          .from(subagents)
          .where(eq(subagents.sessionId, session.id))
          .all()) {
          db.update(subagents)
            .set({ filePath: path.join(newDir, path.relative(oldDir, sub.filePath)) })
            .where(eq(subagents.filePath, sub.filePath))
            .run();
        }
      }
      db.update(sessions).set({ liveId }).where(eq(sessions.id, session.id)).run();
    })();
    return launch({
      liveId,
      kind: 'resume',
      variantId: body.variantId,
      ...modelOf(body),
      environment: 'real',
      cwd,
      claudeSessionId: session.id,
      sessionArgs: ['--resume', session.id],
      projectDirName: path.basename(path.dirname(target)),
      driver: body.driver,
      persona: resumePersona(session, item),
      eval: null,
      extraEnv: {},
      start: { copiedFrom: copied ? session.filePath : null },
    });
  }

  // Contracts 14.5"导入到交互区"：为每个 session 建一项（real 环境，cwd 为 session 记录的 cwd），不启动进程；
  // 已关闭的项恢复显示。先检查全部：有不存在的 404，有显示中的项的 409 并列出，都不改动
  function importSessions(sessionIds: string[]): LiveSummary[] {
    const ids = [...new Set(sessionIds)];
    const rows = ids.map((id) => ({
      id,
      session: db.select().from(sessions).where(eq(sessions.id, id)).get(),
      item: itemOfSession(id),
    }));
    const missing = rows.filter((r) => r.session === undefined).map((r) => r.id);
    if (missing.length > 0) throw new HttpError(404, `session 不存在：${missing.join(', ')}`);
    // 已关闭的项不算在交互区：导入即恢复显示
    const taken = rows.flatMap(({ id, item }) =>
      item?.hiddenAt === null ? [`${id}（${item.id}）`] : [],
    );
    if (taken.length > 0) throw new HttpError(409, `这些 session 已在交互区：${taken.join(', ')}`);
    const noCwd = rows.filter((r) => r.item === null && r.session?.cwd == null).map((r) => r.id);
    if (noCwd.length > 0)
      throw new HttpError(400, `这些 session 没有记录工作目录：${noCwd.join(', ')}`);
    const liveIds = db.$client.transaction(() =>
      rows.map(({ id, session, item }) => {
        if (item !== null) {
          setHidden(item.id, false, { reason: 'import' });
          return item.id;
        }
        if (session?.cwd == null) throw new Error(`session ${id} 没有记录工作目录`);
        const liveId = newId('l');
        const title = sessionListTitle(id);
        insertItem({
          id: liveId,
          claudeSessionId: id,
          title,
          environment: 'real',
          workflow: null,
          input: null,
          taskId: null,
          cwd: session.cwd,
        });
        db.insert(liveEvents)
          .values({
            liveId,
            processId: null,
            at: new Date(),
            kind: 'import',
            payload: { sessionId: id, filePath: session.filePath, title },
          })
          .run();
        db.update(sessions).set({ liveId }).where(eq(sessions.id, id)).run();
        return liveId;
      }),
    )();
    for (const [i, liveId] of liveIds.entries()) {
      events.publish({ type: 'live.updated', liveId });
      const sessionId = ids[i];
      if (sessionId !== undefined) events.publish({ type: 'session.updated', sessionId });
    }
    return liveIds.map((liveId) => summary(row(liveId)));
  }

  // 关闭（"×"）与恢复显示：只改 hidden_at 并记一条事件；已经是这个状态时不记
  function setHidden(id: string, hidden: boolean, payload: Record<string, unknown>) {
    const item = row(id);
    if ((item.hiddenAt !== null) === hidden) return;
    const at = new Date();
    db.update(liveSessions)
      .set({ hiddenAt: hidden ? at : null })
      .where(eq(liveSessions.id, id))
      .run();
    db.insert(liveEvents)
      .values({ liveId: id, processId: null, at, kind: hidden ? 'hide' : 'unhide', payload })
      .run();
  }

  // 有运行中进程的项不能关闭或删除，先结束进程（Contracts 14.5）
  function requireStopped(id: string, action: string) {
    if (controllers.has(id) || running(id)) {
      throw new HttpError(409, `交互 ${id} 有运行中的进程，先结束进程再${action}`);
    }
  }

  function hide(id: string): LiveDetail {
    requireStopped(id, '关闭');
    setHidden(id, true, { reason: 'user' });
    events.publish({ type: 'live.updated', liveId: id });
    return detail(id);
  }

  function unhide(id: string): LiveDetail {
    setHidden(id, false, { reason: 'user' });
    events.publish({ type: 'live.updated', liveId: id });
    return detail(id);
  }

  // 删除一项（Contracts 14.5）：交互项、它的进程与事件记录、data/live/<liveId>/。session 本身不删（jsonl 与副本、
  // Sessions 中的记录，sessions.live_id 置空），GitHub 仓库与 Linear 工单由用户处理
  function remove(id: string, confirmTitle: string) {
    const item = row(id);
    requireStopped(id, '删除');
    if (confirmTitle !== item.title) {
      throw new HttpError(400, `输入的名字与这一项的名字不同：${JSON.stringify(confirmTitle)}`);
    }
    const counts = db.$client.transaction(() => {
      const unlinked = db
        .update(sessions)
        .set({ liveId: null })
        .where(eq(sessions.liveId, id))
        .returning({ id: sessions.id })
        .all();
      const removedEvents = db.delete(liveEvents).where(eq(liveEvents.liveId, id)).run().changes;
      const removedProcesses = db
        .delete(liveProcesses)
        .where(eq(liveProcesses.liveId, id))
        .run().changes;
      // Codex 会话的草稿保留（Contracts 17.3）
      db.update(workflowDrafts).set({ liveId: null }).where(eq(workflowDrafts.liveId, id)).run();
      db.delete(liveSessions).where(eq(liveSessions.id, id)).run();
      return { unlinked: unlinked.map((s) => s.id), removedEvents, removedProcesses };
    })();
    const dir = liveDir(id);
    fs.rmSync(dir, { recursive: true, force: true });
    console.info(
      `[live] 删除交互 ${id}（${item.title}）：${String(counts.removedProcesses)} 个进程、${String(counts.removedEvents)} 条事件、${dir}；session ${counts.unlinked.join(', ')} 保留`,
    );
    events.publish({ type: 'live.updated', liveId: id });
    for (const sessionId of counts.unlinked) events.publish({ type: 'session.updated', sessionId });
  }

  // Contracts 14.3：改名立即反映在标签页、Sessions 列表与详情中
  function rename(id: string, title: string): LiveDetail {
    const item = row(id);
    const next = checkTitle(title);
    if (next !== item.title) {
      const at = new Date();
      db.$client.transaction(() => {
        db.update(liveSessions)
          .set({ title: next, updatedAt: at })
          .where(eq(liveSessions.id, id))
          .run();
        db.insert(liveEvents)
          .values({
            liveId: id,
            processId: null,
            at,
            kind: 'rename',
            payload: { from: item.title, to: next },
          })
          .run();
      })();
      events.publish({ type: 'live.updated', liveId: id });
      events.publish({ type: 'session.updated', sessionId: item.claudeSessionId });
    }
    return detail(id);
  }

  return {
    // 有运行中进程的在前，其余按 updated_at 倒序（Contracts 14.3）；已关闭的项只在 includeHidden 时列出
    list(includeHidden = false): LiveSummary[] {
      return db
        .select()
        .from(liveSessions)
        .where(includeHidden ? undefined : isNull(liveSessions.hiddenAt))
        .orderBy(
          sql`case when exists (select 1 from ${liveProcesses} where ${liveProcesses.liveId} = ${liveSessions.id} and ${liveProcesses.status} = 'running') then 0 else 1 end`,
          desc(liveSessions.updatedAt),
        )
        .all()
        .map(summary);
    },
    get: detail,
    create,
    // 用 Codex 生成 workflow 或 variant 的会话（Contracts 17.3），由草稿模块发起
    createCodex: (input: { cwd: string; prompt: string; title: string; workflow: string | null }) =>
      launchCodex({ kind: 'start', ...input }),
    resumeCodex: (id: string) => launchCodex({ kind: 'resume', liveId: id }),
    resume,
    resumeDefaults,
    rename,
    importSessions,
    hide,
    unhide,
    remove,
    // "在访达中打开"的两个目录（Contracts 14.2）：工作目录与最近一次进程的配置目录（本机配置时为 <HOME>/.claude，
    // Codex 会话为草稿的 CODEX_HOME）
    dirs(id: string): { cwd: string; configDir: string } {
      const r = row(id);
      if (r.engine === 'codex') return { cwd: r.cwd, configDir: codexDirsOf(r.cwd).codexHome };
      const variantId = latestProcess(id)?.variantId ?? null;
      return {
        cwd: r.cwd,
        configDir:
          variantId === null
            ? path.join(deps.localHome, '.claude')
            : variants.layout(variantId).claudeDir,
      };
    },
    hook(id: string, payload: HookPayload) {
      claudeControllerOf(id).hook(payload);
    },
    setDriver(id: string, driver: LiveDriver) {
      const controller = claudeControllerOf(id);
      if (controller.driver === driver) throw new HttpError(409, `驾驶者已经是 ${driver}`);
      if (driver === 'simulated') controller.release();
      else controller.setDriver('human', 'manual' satisfies HandBackReason);
      return detail(id);
    },
    async stop(id: string) {
      const controller = controllerOf(id);
      controller.pty.kill('SIGHUP');
      await controller.exited;
      return detail(id);
    },
    // WebSocket 连接用：运行中的 controller，已退出时为空（只回放 pty.log）
    controller(id: string): LiveController | CodexRunner | null {
      row(id);
      return controllers.get(id) ?? null;
    },
    logFile(id: string): string {
      return path.join(liveDir(row(id).id), 'pty.log');
    },
    // 服务关闭：结束全部 PTY 进程
    async shutdown() {
      for (const controller of controllers.values()) {
        db.update(liveProcesses)
          .set({ error: '服务关闭，进程结束' })
          .where(eq(liveProcesses.id, controller.processId))
          .run();
      }
      await Promise.all([...controllers.values()].map((c) => c.shutdown()));
    },
  };
}

export type Live = ReturnType<typeof createLive>;
