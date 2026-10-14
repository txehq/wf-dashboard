import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { sessionTitle } from '../api/user-text.js';
import type { Db } from '../db/index.js';
import {
  type LiveDriver,
  type LiveEngine,
  type LiveEnvironment,
  liveEvents,
  type LiveProcessKind,
  liveProcesses,
  type LivePurpose,
  liveSessions,
  magiAgentCurrent,
  magiDeploys,
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
import { isolatedBaseEnv, writeSessionClaudeConfig } from '../variants/claude-config.js';
import { HttpError } from '../variants/errors.js';
import type { Variants } from '../variants/index.js';
import { sessionSandboxProfile } from '../variants/sandbox.js';
import { entryOf, evalSpec } from '../workflows/eval-kinds.js';
import { evalSpecOf, workflowOfVariant, workflowRow } from '../workflows/index.js';
import type { EvalSpec } from '../workflows/schema.js';
import {
  CodexRunner,
  codexAgentResumeArgs,
  codexAgentStartArgs,
  codexConfigExtra,
  codexDirsOf,
  codexResumeArgs,
  codexStartArgs,
  newSessionId,
  rolloutFiles,
  waitForSession,
} from './codex.js';
import { type HandBackReason, type HookPayload, LiveController } from './controller.js';
import { claudeSessionDirsOf } from './claude-session.js';
import { LivePty, unreleasedPtys } from './pty.js';
import { divergedName, lastMessage, relationOf, syncSessionDir } from './resume-plan.js';
import {
  type CreateLiveBody,
  type LiveDetail,
  type LiveEventView,
  type LiveProcessView,
  type LiveSummary,
  type ResumeCopy,
  type ResumeDefaults,
  type ResumeLiveBody,
  type ResumePlan,
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
  // Claude Code 会话运行的命令（config.claudeBin）
  claudeBin: string;
  // 设计与分析优化的 Claude Code 会话的凭据与模型配置的来源（Contracts 22.2），默认 config.claudeSettingsPath
  claudeSettingsPath?: string | undefined;
  // 自动结束与"结束进程"（Contracts 14.3）：没有任何页面连接持续 idleMs 时结束全部运行中的交互进程；
  // 结束时先 SIGINT，graceMs 后仍在则 SIGTERM
  autoStop: { idleMs: number; graceMs: number };
}

export const LIVE_ID = /^l-\d{8}-[a-z0-9]{6}$/;

// 现场输入时模拟用户扮演的人（Contracts 14.4）
const INPUT_PERSONA = '提出这个想法（或工单）的人，只依据输入回答，没写到的按常理回答。';
const RESUME_PERSONA =
  '这个 session 中与 agent 对话的用户，只依据之前的对话回答，没写到的按常理回答。';

const HOOK_EVENTS = ['Stop', 'Notification', 'UserPromptSubmit', 'SessionStart'] as const;

// 新建的项的默认名字：输入的前 40 个字（Contracts 14.3）
const DEFAULT_TITLE_LENGTH = 40;

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
  // 设计与分析优化的 Claude Code 会话（Contracts 22.2）：配置目录、完整的 env 与 sandbox 由会话自己所有，
  // 不属于任何 variant，也不是本机配置；其余的项为空
  owned: OwnedClaude | null;
}

interface OwnedClaude {
  claudeDir: string;
  env: Record<string, string>;
  // claude 要读的 hooks 设置文件由 launch 写出，sandbox 放行它
  sandboxProfile: (hooksFile: string) => string;
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

  // "结束进程"（Contracts 14.3）：先 SIGINT，graceMs 后仍在则 SIGTERM，等进程退出
  async function terminate(controller: LiveController | CodexRunner) {
    controller.pty.kill('SIGINT');
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<'late'>((resolve) => {
      timer = setTimeout(() => {
        resolve('late');
      }, deps.autoStop.graceMs);
    });
    const outcome = await Promise.race([controller.exited.then(() => 'exited' as const), late]);
    clearTimeout(timer);
    if (outcome === 'late' && controller.pty.alive) controller.pty.kill('SIGTERM');
    await controller.exited;
  }

  // 自动结束（Contracts 14.3）：页面的连接（/api/events 的 SSE 与 PTY 的 WebSocket）为 0 时开始计时，
  // idleMs 内有连接回来就取消；到时仍为 0 时结束全部运行中的交互进程，每项记一条 auto-stop。评测的 run 不在这里，不受影响
  let connections = 0;
  // 最后一个连接断开的时间；服务启动后还没有过连接时为空
  let lastDisconnectAt: Date | null = null;
  let idleTimer: NodeJS.Timeout | null = null;

  function scheduleAutoStop() {
    if (connections > 0 || idleTimer !== null || controllers.size === 0) return;
    idleTimer = setTimeout(() => {
      idleTimer = null;
      void autoStopAll();
    }, deps.autoStop.idleMs);
  }

  function cancelAutoStop() {
    if (idleTimer === null) return;
    clearTimeout(idleTimer);
    idleTimer = null;
  }

  async function autoStopAll() {
    if (connections > 0) return;
    const running = [...controllers.values()].filter((c) => c.pty.alive);
    for (const c of running) {
      db.insert(liveEvents)
        .values({
          liveId: c.liveId,
          processId: c.processId,
          at: new Date(),
          kind: 'auto-stop',
          payload: {
            lastDisconnectAt: lastDisconnectAt?.toISOString() ?? null,
            idleMs: deps.autoStop.idleMs,
          },
        })
        .run();
      events.publish({ type: 'live.updated', liveId: c.liveId });
    }
    await Promise.all(running.map((c) => terminate(c)));
  }

  // 一个页面连接：打开时调用，返回关闭时调用的函数（重复调用只算一次）
  function connect(): () => void {
    connections += 1;
    cancelAutoStop();
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      connections -= 1;
      if (connections === 0) {
        lastDisconnectAt = new Date();
        scheduleAutoStop();
      }
    };
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
      model: p.model,
      effort: p.effort,
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
      .select({
        id: workflowDrafts.id,
        mode: workflowDrafts.mode,
        analysisId: workflowDrafts.analysisId,
      })
      .from(workflowDrafts)
      .where(eq(workflowDrafts.liveId, r.id))
      .get();
    return {
      id: r.id,
      title: r.title,
      claudeSessionId: r.claudeSessionId,
      engine: r.engine,
      purpose: r.purpose,
      // 设计的是新 workflow 还是新 variant；其余用途为空
      designMode:
        r.purpose === 'design' && (draft?.mode === 'workflow' || draft?.mode === 'variant')
          ? draft.mode
          : null,
      // 优化会话对应的分析（Contracts 19.3）
      analysisId: r.purpose === 'optimize' ? (draft?.analysisId ?? null) : null,
      draftId: draft?.id ?? null,
      environment: r.environment,
      workflow: r.workflow,
      input: r.input,
      taskId: r.taskId,
      cwd: r.cwd,
      process,
      variantId: process?.variantId ?? null,
      // 设计与分析优化的会话没有 variant，显示引擎的名字
      variantName:
        process?.variantName ??
        (isDraftItem(r) && process !== null
          ? r.engine === 'codex'
            ? 'Codex'
            : 'Claude Code'
          : null),
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
      // 最近的进程是页面全部关闭后自动结束的（Contracts 14.3）
      autoStopped:
        last?.status === 'exited' &&
        db
          .select({ id: liveEvents.id })
          .from(liveEvents)
          .where(and(eq(liveEvents.processId, last.id), eq(liveEvents.kind, 'auto-stop')))
          .get() !== undefined,
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
    // Codex 草稿的项在 Codex 第一次启动之前为空
    claudeSessionId: string | null;
    engine?: 'claude' | 'codex';
    // 不传时为 interaction（新建、导入、resume 的普通项）
    purpose?: LivePurpose;
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
    let configDir: string;
    if (spec.owned !== null) {
      env = { ...spec.owned.env };
      variantArgs = [];
      sandboxProfile = spec.owned.sandboxProfile(hooksFile);
      configDir = spec.owned.claudeDir;
    } else if (spec.variantId === null) {
      // 本机配置：不设 CLAUDE_CONFIG_DIR，claude 用 <HOME>/.claude
      env = { ...isolatedBaseEnv(), HOME: deps.localHome };
      variantArgs = [];
      configDir = configDirOf(null);
    } else {
      variants.refreshAuthEnv(spec.variantId);
      // 工作目录的信任确认（Contracts 14.2）：variant 的配置目录中先记为已信任
      variants.trustDirectory(spec.variantId, spec.cwd);
      const runtime = variants.runtimeEnv(spec.variantId);
      env = { ...runtime.env };
      configDir = runtime.env.CLAUDE_CONFIG_DIR;
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
      configDir,
      'projects',
      spec.projectDirName,
      `${spec.claudeSessionId}.jsonl`,
    );
    const startedAt = new Date();
    const pty = new LivePty({
      file: sandboxProfile === null ? deps.claudeBin : 'sandbox-exec',
      args: sandboxProfile === null ? args : ['-p', sandboxProfile, deps.claudeBin, ...args],
      cwd: spec.cwd,
      env,
      cols: 120,
      rows: 40,
      logFile: path.join(dir, 'pty.log'),
      separator: separatorLine(
        startedAt,
        spec.kind,
        spec.owned !== null ? 'Claude Code' : (variantName(spec.variantId) ?? '本机配置'),
      ),
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
            configDir: spec.variantId === null && spec.owned === null ? null : configDir,
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
    scheduleAutoStop();
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
      owned: null,
    });
  }

  // 设计与分析优化的项（Contracts 17.1、19.3、22.1）：发起时立即建出，没有进程，也还没有会话 id；草稿准备完后由
  // launchDraft 启动。engine 为发起时选的 Codex 或 Claude Code
  function createDraftItem(input: {
    cwd: string;
    prompt: string;
    title: string;
    workflow: string | null;
    purpose: 'design' | 'optimize';
    engine: 'codex' | 'claude';
  }): LiveDetail {
    const liveId = newId('l');
    insertItem({
      id: liveId,
      claudeSessionId: null,
      engine: input.engine,
      purpose: input.purpose,
      title: Array.from(input.title.trim()).slice(0, DEFAULT_TITLE_LENGTH).join(''),
      // Codex 自己的沙箱与 Claude Code 外面的 sandbox 都只允许写工作目录
      environment: 'isolated',
      workflow: input.workflow,
      input: input.prompt,
      taskId: null,
      cwd: input.cwd,
    });
    events.publish({ type: 'live.updated', liveId });
    return detail(liveId);
  }

  // 设计与分析优化的项：只有人驾驶，没有模拟用户（Contracts 17.3、22.2）
  const isDraftItem = (r: ItemRow) => r.purpose === 'design' || r.purpose === 'optimize';

  // 正在启动、还没有登记进 controllers 的项
  const launching = new Set<string>();

  // 设计与分析优化会话的一个进程：项还没有会话 id 时以初始消息第一次启动，已有时 resume 接着同一个会话
  async function launchDraft(liveId: string, kind: LiveProcessKind): Promise<LiveDetail> {
    const item = row(liveId);
    if (!isDraftItem(item)) {
      throw new HttpError(400, `交互 ${item.id} 不是设计或分析优化的会话`);
    }
    if (launching.has(liveId) || controllers.has(liveId) || running(liveId)) {
      throw new HttpError(409, `交互 ${item.id} 有运行中的进程`);
    }
    if (kind === 'resume' && item.claudeSessionId === null) {
      throw new HttpError(409, `交互 ${item.id} 还没有启动过，没有可以 resume 的会话`);
    }
    if (kind === 'start' && item.claudeSessionId !== null) {
      throw new HttpError(409, `交互 ${item.id} 已经启动过，用 resume 接着会话`);
    }
    launching.add(liveId);
    const started =
      item.engine === 'codex'
        ? startCodexProcess(item, kind)
        : Promise.resolve().then(() => startDraftClaude(item, kind));
    return started.finally(() => {
      launching.delete(liveId);
    });
  }

  // Claude Code 的设计与分析优化会话（Contracts 22.2）：配置目录为工作目录中的 claude-config/，每次启动与 resume
  // 前重写凭据、引导与信任；进程在 sandbox 中，只能写工作目录与 npm 缓存；会话 id 在第一次启动时生成
  function startDraftClaude(item: ItemRow, kind: LiveProcessKind): LiveDetail {
    const { claudeDir } = claudeSessionDirsOf(item.cwd);
    writeSessionClaudeConfig(claudeDir, item.cwd, deps.claudeSettingsPath);
    const sessionId = item.claudeSessionId ?? randomUUID();
    if (item.claudeSessionId === null) {
      db.update(liveSessions)
        .set({ claudeSessionId: sessionId })
        .where(eq(liveSessions.id, item.id))
        .run();
    }
    setHidden(item.id, false, { reason: kind });
    const program = path.isAbsolute(deps.claudeBin) ? [fs.realpathSync(deps.claudeBin)] : [];
    return launch({
      liveId: item.id,
      kind,
      variantId: null,
      model: '',
      effort: '',
      environment: 'isolated',
      cwd: item.cwd,
      claudeSessionId: sessionId,
      sessionArgs:
        kind === 'start' ? ['--session-id', sessionId, item.input ?? ''] : ['--resume', sessionId],
      projectDirName: item.id,
      driver: 'human',
      persona: { stage: null, persona: INPUT_PERSONA, hiddenRequirements: '' },
      eval: null,
      extraEnv: {},
      start: { engine: 'claude', claudeDir },
      owned: {
        claudeDir,
        env: {
          ...isolatedBaseEnv(),
          CLAUDE_CONFIG_DIR: claudeDir,
          // 进程本来就在 sandbox 中，Claude Code 不再询问是否信任工作目录
          CLAUDE_CODE_SANDBOXED: '1',
          // npx 的缓存仍用用户自己的 ~/.npm
          npm_config_cache: path.join(os.homedir(), '.npm'),
        },
        sandboxProfile: (hooksFile) => sessionSandboxProfile(item.cwd, [hooksFile, ...program]),
      },
    });
  }

  async function startCodexProcess(item: ItemRow, kind: LiveProcessKind): Promise<LiveDetail> {
    const liveId = item.id;
    const cwd = item.cwd;
    const args =
      item.claudeSessionId === null
        ? codexStartArgs(item.input ?? '')
        : codexResumeArgs(item.claudeSessionId);
    const { codexHome, home } = codexDirsOf(cwd);
    const dir = liveDir(liveId);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    // 每次启动前重写：认证与模型配置可能变了；Codex 自己写进 config.toml 的键随之丢弃，下次启动时重新生成
    const { model, effort } = writeCodexHome(codexHome, deps.codex.sources, codexConfigExtra(cwd));
    const env = {
      ...isolatedBaseEnv(),
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
      separator: separatorLine(startedAt, kind, 'Codex'),
    });
    const sessionId =
      item.claudeSessionId ??
      (await waitForSession(pty, codexHome, cwd, known, deps.codex.sessionTimeoutMs));
    const processId = db.$client.transaction(() => {
      if (item.claudeSessionId === null) {
        db.update(liveSessions)
          .set({ claudeSessionId: sessionId })
          .where(eq(liveSessions.id, liveId))
          .run();
      }
      setHidden(liveId, false, { reason: kind });
      const inserted = db
        .insert(liveProcesses)
        .values({
          liveId,
          kind,
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
          kind,
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
    scheduleAutoStop();
    events.publish({ type: 'live.updated', liveId });
    return detail(liveId);
  }

  // Magi Agent 的会话（Contracts 23.1）：real 环境，cwd 为 worktree。Claude Code 的会话 id 建项时定下；
  // Codex 的会话 id 等用户提交第一条消息、Codex 写出 rollout 后记下
  function createAgentItem(input: { engine: LiveEngine; cwd: string; title: string }): LiveDetail {
    const liveId = newId('l');
    insertItem({
      id: liveId,
      claudeSessionId: input.engine === 'claude' ? randomUUID() : null,
      engine: input.engine,
      purpose: 'agent',
      title: input.title,
      environment: 'real',
      workflow: null,
      input: null,
      taskId: null,
      cwd: input.cwd,
    });
    events.publish({ type: 'live.updated', liveId });
    return detail(liveId);
  }

  // 启动或 resume Magi Agent 的会话（Contracts 23.3）：本机配置，只有人驾驶，MAGI.md 的内容追加进系统提示；
  // 还没有对话记录时（启动后没有提交过消息）以同一个会话重新启动。message 为 resume 时提交的消息（部署完成）
  function launchAgent(
    liveId: string,
    opts: { instructions: string; message: string | null },
  ): LiveDetail {
    const item = row(liveId);
    if (item.purpose !== 'agent') {
      throw new HttpError(400, `交互 ${item.id} 不是 Magi Agent 的会话`);
    }
    if (launching.has(liveId) || controllers.has(liveId) || running(liveId)) {
      throw new HttpError(409, `交互 ${item.id} 有运行中的进程`);
    }
    // agent 调用部署接口时带上自己的 live id；dashboard 的地址是服务实际监听的地址
    const magiEnv = { MAGI_LIVE_ID: liveId, MAGI_DASHBOARD_URL: deps.serverUrl() };
    const message = opts.message === null ? [] : [opts.message];
    if (item.engine === 'codex') return startAgentCodex(item, opts, magiEnv);
    const sessionId = item.claudeSessionId;
    if (sessionId === null) throw new Error(`Magi Agent 的 Claude Code 会话 ${liveId} 没有会话 id`);
    const kind = locate(configDirOf(null), sessionId) === null ? 'start' : 'resume';
    return launch({
      liveId,
      kind,
      variantId: null,
      ...modelOf({}),
      environment: 'real',
      cwd: item.cwd,
      claudeSessionId: sessionId,
      sessionArgs:
        kind === 'start'
          ? ['--append-system-prompt', opts.instructions, '--session-id', sessionId, ...message]
          : ['--resume', sessionId, '--append-system-prompt', opts.instructions, ...message],
      projectDirName: liveId,
      driver: 'human',
      persona: { stage: null, persona: RESUME_PERSONA, hiddenRequirements: '' },
      eval: null,
      extraEnv: magiEnv,
      start: { magiAgent: true, message: opts.message },
      owned: null,
    });
  }

  function startAgentCodex(
    item: ItemRow,
    opts: { instructions: string; message: string | null },
    magiEnv: Record<string, string>,
  ): LiveDetail {
    const liveId = item.id;
    const kind: LiveProcessKind = item.claudeSessionId === null ? 'start' : 'resume';
    const args =
      item.claudeSessionId === null
        ? codexAgentStartArgs(item.cwd, opts.instructions, opts.message)
        : codexAgentResumeArgs(item.cwd, opts.instructions, item.claudeSessionId, opts.message);
    // 用户自己的 ~/.codex：不设 CODEX_HOME，不改 HOME
    const env: Record<string, string> = {
      ...isolatedBaseEnv(),
      HOME: deps.localHome,
      ...magiEnv,
      COLORTERM: 'truecolor',
    };
    const codexHome = env.CODEX_HOME ?? path.join(deps.localHome, '.codex');
    const known = new Set(rolloutFiles(codexHome));
    const dir = liveDir(liveId);
    fs.mkdirSync(dir, { recursive: true });
    const startedAt = new Date();
    const pty = new LivePty({
      file: deps.codex.bin,
      args,
      cwd: item.cwd,
      env,
      cols: 120,
      rows: 40,
      logFile: path.join(dir, 'pty.log'),
      separator: separatorLine(startedAt, kind, 'Codex'),
    });
    const processId = db.$client.transaction(() => {
      setHidden(liveId, false, { reason: kind });
      const inserted = db
        .insert(liveProcesses)
        .values({
          liveId,
          kind,
          variantId: null,
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
          kind,
          payload: {
            engine: 'codex',
            magiAgent: true,
            argv: [deps.codex.bin, ...args],
            codexHome,
            sessionId: item.claudeSessionId,
            message: opts.message,
          },
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
    if (item.claudeSessionId === null) void recordCodexSession(liveId, pty, codexHome, known);
    scheduleAutoStop();
    events.publish({ type: 'live.updated', liveId });
    return detail(liveId);
  }

  // 用户提交第一条消息后 Codex 才写出 rollout：进程运行期间每秒找一次 cwd 为 worktree 的新 rollout，找到后记下会话 id
  async function recordCodexSession(
    liveId: string,
    pty: LivePty,
    codexHome: string,
    known: Set<string>,
  ) {
    const cwd = row(liveId).cwd;
    // worktree 被删除后进程的 cwd 已不在，不再找
    while (pty.alive && fs.existsSync(cwd)) {
      const sessionId = newSessionId(codexHome, cwd, known);
      if (sessionId !== null) {
        db.update(liveSessions)
          .set({ claudeSessionId: sessionId })
          .where(eq(liveSessions.id, liveId))
          .run();
        events.publish({ type: 'live.updated', liveId });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
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

  function copyOf(file: string): ResumeCopy {
    const last = lastMessage(file);
    return {
      path: file,
      bytes: fs.statSync(file).size,
      lastAt: last.at,
      lastRole: last.role,
      lastText: last.text,
    };
  }

  // resume 的预检（Contracts 14.5）：在哪个配置中、用哪一份 jsonl 接着运行，或为什么不能 resume
  function resumePlan(sessionId: string, variantId: string | null): ResumePlan {
    const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (session === undefined) throw new HttpError(404, `session 不存在：${sessionId}`);
    const item = itemOfSession(sessionId);
    const problems: ResumePlan['problems'] = [];
    const notes: string[] = [];
    if (session.cwd === null) {
      problems.push({
        code: 'no-cwd',
        message: '这个 session 没有记录工作目录，不知道在哪里接着运行。',
      });
    } else if (!fs.statSync(session.cwd, { throwIfNoEntry: false })?.isDirectory()) {
      problems.push({
        code: 'cwd-missing',
        message: `工作目录 ${session.cwd} 已经不在了。把目录放回原处后再 resume。`,
      });
    }
    let configDir: string;
    if (variantId === null) {
      configDir = configDirOf(null);
    } else {
      const variant = variants.get(variantId);
      configDir = variants.layout(variantId).claudeDir;
      if (variant.buildStatus !== 'built' || variant.builtHash !== variant.skillsHash) {
        problems.push({
          code: 'variant-not-built',
          message: `variant ${variant.name} 还没有按当前内容构建成功。先在 variant 页面构建，或改选别的配置。`,
        });
      }
    }
    if (item !== null && (controllers.has(item.id) || running(item.id))) {
      problems.push({
        code: 'running',
        message: `这个 session 正在交互项「${item.title}」中运行。先在那里结束进程再 resume。`,
      });
    }
    const latestExists = fs.existsSync(session.filePath);
    const targetFile = locate(configDir, session.id);
    const latest = latestExists ? copyOf(session.filePath) : null;
    const target = targetFile === null ? null : copyOf(targetFile);
    let action: ResumePlan['action'];
    if (!latestExists) {
      problems.push({
        code: 'file-missing',
        message:
          targetFile === null
            ? `session 文件 ${session.filePath} 已经不在了（被移走或删除），没有可以接着运行的记录。`
            : `最新的 session 文件 ${session.filePath} 已经不在了；目标配置中有一份 ${targetFile}，但无法确认它包含全部对话，不接着运行。把文件放回原处后再 resume。`,
      });
      action = 'blocked';
    } else if (targetFile === null) {
      action = 'copy';
    } else {
      const relation = relationOf(session.filePath, targetFile);
      action = relation === 'behind' ? 'sync' : relation === 'diverged' ? 'diverged' : 'resume';
    }
    if (problems.length > 0) action = 'blocked';
    // 有子代理的 session：子代理的记录在与 jsonl 同名的目录中，复制与同步时一起带上
    const subagentCount = db
      .select({ n: sql<number>`count(*)` })
      .from(subagents)
      .where(eq(subagents.sessionId, session.id))
      .get()?.n;
    const sessionDir = path.join(path.dirname(session.filePath), session.id);
    if ((subagentCount ?? 0) > 0 && latestExists && !fs.existsSync(sessionDir)) {
      notes.push(
        `子代理的记录目录 ${sessionDir} 不在：主对话照常接着运行，之前子代理的明细不会带进目标配置。`,
      );
    }
    const { agentModel, agentEffort } = settings.get();
    return {
      sessionId,
      variantId,
      configDir,
      liveId: item?.id ?? null,
      cwd: session.cwd,
      model: variantId === null ? null : agentModel,
      effort: variantId === null ? null : agentEffort,
      action,
      latest,
      target,
      problems,
      notes,
    };
  }

  // Contracts 14.5：环境固定为 real，工作目录为 session 记录的 cwd；session 已属于某一项时在这一项上接着运行，
  // 否则为它建一项。目标配置中已有另一份时按预检同步或要求用户选择
  function resume(body: ResumeLiveBody): LiveDetail {
    const plan = resumePlan(body.sessionId, body.variantId);
    const problem = plan.problems[0];
    if (problem !== undefined) throw new HttpError(409, problem.message);
    if (plan.action === 'diverged' && body.onDiverged !== 'use-latest') {
      throw new HttpError(
        409,
        '目标配置中的那份与最新的分叉了，要在对话框中选择"以最新的为准继续"',
      );
    }
    const session = db.select().from(sessions).where(eq(sessions.id, body.sessionId)).get();
    if (session === undefined) throw new HttpError(404, `session 不存在：${body.sessionId}`);
    const cwd = plan.cwd;
    if (cwd === null) throw new Error(`session ${session.id} 没有工作目录却通过了预检`);
    const item = itemOfSession(session.id);
    // Magi Agent 的会话带着 MAGI.md 启动，从 Magi Agent 打开或 resume（Contracts 23.1）
    if (item?.purpose === 'agent') {
      throw new HttpError(
        409,
        `session ${session.id} 是 Magi Agent 的会话，从 Magi Agent 打开或 resume`,
      );
    }
    const liveId = item?.id ?? newId('l');
    // 先读完最新那份，复制或同步后的字节与已导入的偏移量一致
    ingestFile(db, session.filePath);
    let target: string;
    // 记进这次 resume 事件：复制、覆盖或改名保留了哪一份
    const start: Record<string, unknown> = { copiedFrom: null };
    if (plan.target === null) {
      target = path.join(plan.configDir, 'projects', liveId, `${session.id}.jsonl`);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(session.filePath, target);
      syncSessionDir(session.filePath, target);
      start.copiedFrom = session.filePath;
    } else {
      target = plan.target.path;
      if (plan.action === 'diverged') {
        const kept = divergedName(target, new Date());
        fs.renameSync(target, kept);
        start.divergedKept = kept;
      }
      if (plan.action === 'sync' || plan.action === 'diverged') {
        fs.copyFileSync(session.filePath, target);
        syncSessionDir(session.filePath, target);
        start.syncedFrom = session.filePath;
        start.overwrote = target;
      }
    }
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
      if (target !== session.filePath) {
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
      start,
      owned: null,
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
      // Magi Agent 的会话：不再是当前会话，下次打开时新建；它发起的部署记录一起删除
      db.delete(magiAgentCurrent).where(eq(magiAgentCurrent.liveId, id)).run();
      db.delete(magiDeploys).where(eq(magiDeploys.liveId, id)).run();
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
      if (item.claudeSessionId !== null) {
        events.publish({ type: 'session.updated', sessionId: item.claudeSessionId });
      }
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
    // 设计与分析优化的会话（Contracts 17.1、19.3、22）：草稿模块发起时建项，准备完后启动，Codex 或 Claude Code
    createDraftItem,
    startDraft: (id: string) => launchDraft(id, 'start'),
    resumeDraft: (id: string) => launchDraft(id, 'resume'),
    // Magi Agent（Contracts 第 23 节）
    createAgentItem,
    launchAgent,
    running,
    resume,
    resumeDefaults,
    resumePlan,
    rename,
    importSessions,
    hide,
    unhide,
    remove,
    // "在访达中打开"的两个目录（Contracts 14.2）：工作目录与最近一次进程的配置目录（本机配置时为 <HOME>/.claude，
    // 设计与分析优化的会话为工作目录中的 CODEX_HOME 或 claude-config/）
    dirs(id: string): { cwd: string; configDir: string } {
      const r = row(id);
      if (r.engine === 'codex') return { cwd: r.cwd, configDir: codexDirsOf(r.cwd).codexHome };
      if (isDraftItem(r)) return { cwd: r.cwd, configDir: claudeSessionDirsOf(r.cwd).claudeDir };
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
      if (row(id).purpose === 'agent') {
        throw new HttpError(409, `交互 ${id} 是 Magi Agent 的会话，只有人驾驶`);
      }
      const controller = claudeControllerOf(id);
      // 设计与分析优化的 Claude Code 会话只有人驾驶（Contracts 22.2）
      if (isDraftItem(row(id))) {
        throw new HttpError(409, `交互 ${id} 是设计或分析优化的会话，只有人驾驶，没有模拟用户`);
      }
      if (controller.driver === driver) throw new HttpError(409, `驾驶者已经是 ${driver}`);
      if (driver === 'simulated') controller.release();
      else controller.setDriver('human', 'manual' satisfies HandBackReason);
      return detail(id);
    },
    async stop(id: string) {
      await terminate(controllerOf(id));
      return detail(id);
    },
    connect,
    // GET /api/diagnostics（Contracts 第 5 节）：页面连接数、自动结束是否在计时、仍保留的各项 controller
    diagnostics() {
      return {
        connections,
        autoStopPending: idleTimer !== null,
        controllers: [...controllers.values()].map((c) => ({
          liveId: c.liveId,
          engine: c.engine,
          pid: c.pty.pid,
          alive: c.pty.alive,
          retainedBytes: c.pty.retainedBytesCount,
          screenReleased: c.pty.screenReleased,
          watching: c.watching,
        })),
        ptys: unreleasedPtys(),
      };
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
      cancelAutoStop();
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
