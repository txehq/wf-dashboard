import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { execa } from 'execa';
import type { Db } from '../db/index.js';
import {
  type LiveDriver,
  liveEvents,
  liveSessions,
  runs,
  sessions,
  subagents,
  variants as variantsTable,
  type Workflow,
} from '../db/schema.js';
import { events } from '../events.js';
import { createEmptyRunRepo, createRunRepo } from '../external/github.js';
import { createRunTicket } from '../external/linear.js';
import { ingestFile } from '../ingest/ingest.js';
import { newId } from '../runs/index.js';
import type { SettingsStore } from '../runs/settings.js';
import type { EvalFacts, SimulatedPersona } from '../runs/simulated-user.js';
import { issueIdentifier } from '../tasks/import-schema.js';
import { loadTask } from '../tasks/loader.js';
import type { Task } from '../tasks/schema.js';
import { HttpError } from '../variants/errors.js';
import type { Variants } from '../variants/index.js';
import { type HandBackReason, type HookPayload, LiveController } from './controller.js';
import { LivePty } from './pty.js';
import type {
  CreateLiveBody,
  LiveDetail,
  LiveEventView,
  LiveSummary,
  ResumeDefaults,
  ResumeLiveBody,
} from './views.js';

export interface LiveDeps {
  db: Db;
  variants: Variants;
  settings: SettingsStore;
  vaultDir: string;
  product: string;
  // data/live
  liveDir: string;
  // hook 命令 POST 的地址：服务实际监听的 http://host:port
  serverUrl: () => string;
  // "本机配置"的 HOME（claude 读 <home>/.claude）；测试用 .work/ 下的目录
  localHome: string;
}

export const LIVE_ID = /^l-\d{8}-[a-z0-9]{6}$/;

// 现场输入时模拟用户扮演的人（Contracts 14.4）
const INPUT_PERSONA = '提出这个想法（或工单）的人，只依据输入回答，没写到的按常理回答。';
const RESUME_PERSONA =
  '这个 session 中与 agent 对话的用户，只依据之前的对话回答，没写到的按常理回答。';

const HOOK_EVENTS = ['Stop', 'Notification', 'UserPromptSubmit', 'SessionStart'] as const;

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

interface Launch {
  liveId: string;
  variantId: string | null;
  environment: 'isolated' | 'real';
  workflow: Workflow | null;
  input: string | null;
  taskId: string | null;
  cwd: string;
  claudeSessionId: string;
  resumedFrom: string | null;
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

export function createLive(deps: LiveDeps) {
  const { db, variants, settings } = deps;
  const controllers = new Map<string, LiveController>();

  // 上次服务退出时运行中的交互：PTY 进程随服务退出
  const interrupted = db
    .update(liveSessions)
    .set({ status: 'exited', error: '服务重启中断', endedAt: new Date() })
    .where(eq(liveSessions.status, 'running'))
    .returning({ id: liveSessions.id })
    .all();
  for (const r of interrupted) events.publish({ type: 'live.updated', liveId: r.id });

  function row(id: string) {
    const found = db.select().from(liveSessions).where(eq(liveSessions.id, id)).get();
    if (found === undefined) throw new HttpError(404, `交互不存在：${id}`);
    return found;
  }

  function controllerOf(id: string): LiveController {
    const r = row(id);
    const controller = controllers.get(id);
    if (controller === undefined || r.status !== 'running') {
      throw new HttpError(409, `交互 ${id} 不在运行中`);
    }
    return controller;
  }

  function liveDir(id: string) {
    return path.join(deps.liveDir, id);
  }

  function startPayload(id: string): Record<string, unknown> {
    const start = db
      .select({ payload: liveEvents.payload })
      .from(liveEvents)
      .where(sql`${liveEvents.liveId} = ${id} and ${liveEvents.kind} = 'start'`)
      .get();
    return start?.payload ?? {};
  }

  function summary(r: typeof liveSessions.$inferSelect): LiveSummary {
    const variantName =
      r.variantId === null
        ? null
        : (db
            .select({ name: variantsTable.name })
            .from(variantsTable)
            .where(eq(variantsTable.id, r.variantId))
            .get()?.name ?? null);
    const start = startPayload(r.id);
    const controller = controllers.get(r.id);
    return {
      id: r.id,
      variantId: r.variantId,
      variantName,
      environment: r.environment,
      workflow: r.workflow,
      input: r.input,
      taskId: r.taskId,
      cwd: r.cwd,
      claudeSessionId: r.claudeSessionId,
      resumedFrom: r.resumedFrom,
      pid: r.pid,
      status: r.status,
      exitCode: r.exitCode,
      error: r.error,
      driver: r.driver,
      starting: r.status === 'running' && controller?.starting === true,
      repo: typeof start.repo === 'string' ? start.repo : null,
      ticket: typeof start.ticket === 'string' ? start.ticket : null,
      createdAt: r.createdAt.getTime(),
      endedAt: r.endedAt === null ? null : r.endedAt.getTime(),
    };
  }

  function eventViews(id: string): LiveEventView[] {
    return db
      .select()
      .from(liveEvents)
      .where(eq(liveEvents.liveId, id))
      .orderBy(asc(liveEvents.id))
      .all()
      .map((e) => ({ id: e.id, at: e.at.getTime(), kind: e.kind, payload: e.payload }));
  }

  function detail(id: string): LiveDetail {
    const r = row(id);
    const evs = eventViews(id);
    const lastDriver = evs.findLast((e) => e.kind === 'driver');
    const reason = lastDriver?.payload.reason;
    const handedBack =
      r.driver === 'human' &&
      (reason === 'input' ||
        reason === 'done' ||
        reason === 'max-turns' ||
        reason === 'error' ||
        reason === 'manual')
        ? reason
        : null;
    const controller = controllers.get(id);
    return {
      ...summary(r),
      waiting: r.status === 'running' && controller !== undefined ? controller.waiting : null,
      handedBack,
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

  function launch(spec: Launch): LiveDetail {
    const dir = liveDir(spec.liveId);
    fs.mkdirSync(dir, { recursive: true });
    const hooksFile = writeHooks(spec.liveId);
    let env: Record<string, string>;
    let variantArgs: string[];
    let sandboxProfile: string | null = null;
    if (spec.variantId === null) {
      // 本机配置：不设 CLAUDE_CONFIG_DIR，claude 用 <HOME>/.claude
      env = { ...strippedEnv(), HOME: deps.localHome };
      variantArgs = [];
    } else {
      variants.refreshAuthEnv(spec.variantId);
      const runtime = variants.runtimeEnv(spec.variantId);
      env = { ...runtime.env };
      variantArgs = runtime.claudeArgs;
      if (spec.environment === 'isolated') {
        sandboxProfile = variants.sandboxProfile(spec.variantId, spec.liveId, deps.liveDir);
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
    const pty = new LivePty({
      file: sandboxProfile === null ? 'claude' : 'sandbox-exec',
      args: sandboxProfile === null ? args : ['-p', sandboxProfile, 'claude', ...args],
      cwd: spec.cwd,
      env,
      cols: 120,
      rows: 40,
      logFile: path.join(dir, 'pty.log'),
    });
    db.insert(liveSessions)
      .values({
        id: spec.liveId,
        variantId: spec.variantId,
        environment: spec.environment,
        workflow: spec.workflow,
        input: spec.input,
        taskId: spec.taskId,
        cwd: spec.cwd,
        claudeSessionId: spec.claudeSessionId,
        resumedFrom: spec.resumedFrom,
        pid: pty.pid,
        status: 'running',
        // 收到第一个 SessionStart 之前驾驶者固定为人（Contracts 14.2）
        driver: 'human',
      })
      .run();
    db.insert(liveEvents)
      .values({
        liveId: spec.liveId,
        at: new Date(),
        kind: 'start',
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
    const controller = new LiveController({
      db,
      settings,
      liveId: spec.liveId,
      pty,
      jsonl,
      initialDriver: spec.driver,
      persona: spec.persona,
      eval: spec.eval,
    });
    controllers.set(spec.liveId, controller);
    void controller.exited.then(() => {
      controllers.delete(spec.liveId);
    });
    events.publish({ type: 'live.updated', liveId: spec.liveId });
    return detail(spec.liveId);
  }

  function personaOf(task: Task | null, workflow: Workflow): SimulatedPersona {
    return task ?? { kind: workflow, persona: INPUT_PERSONA, hiddenRequirements: '' };
  }

  // Contracts 14.2
  async function create(body: CreateLiveBody): Promise<LiveDetail> {
    const task = body.taskId === null ? null : loadTask(db, body.taskId);
    if (task !== null && task.kind !== body.workflow) {
      throw new HttpError(400, `task ${task.id} 是 ${task.kind} task，不能用于 /${body.workflow}`);
    }
    if (task === null && body.input === null) throw new HttpError(400, '没有选 task 时需要输入');
    // 构建成功才有 runtimeEnv
    variants.runtimeEnv(body.variantId);
    const liveId = newId('l');
    const sessionId = randomUUID();
    const dir = liveDir(liveId);
    let cwd: string;
    let initial: string;
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
      if (body.workflow === 'lfg') {
        const input = task?.kind === 'lfg' ? task.input : body.input;
        if (input === null) throw new HttpError(400, '没有输入');
        const repo = await createEmptyRunRepo(liveId, signal);
        // wf obsidian 要求 product 目录已存在
        fs.mkdirSync(path.join(deps.vaultDir, `Project ${deps.product}`), { recursive: true });
        extraEnv.MAGI_PRODUCT = deps.product;
        initial = [
          `/lfg ${input}`,
          '',
          `Product: ${deps.product}`,
          `Feature slug: ${liveId}`,
          `Repository: ${repo.repo}`,
        ].join('\n');
        evalFacts = { runId: liveId, repo: repo.repo, ticket: null, product: deps.product };
        start = { repo: repo.repo, repoUrl: repo.url };
      } else {
        // 副本仓库与副本工单都从 task 建立（第 13 节）；粘贴的工单要先另存为 task
        if (task?.kind !== 'ic') {
          throw new HttpError(
            400,
            'isolated 环境的 ic 需要选一个 ic task；粘贴的工单先另存为 task',
          );
        }
        const repo = await createRunRepo(task, liveId, signal);
        const ticket = await createRunTicket(task, liveId);
        initial = `/ic ${ticket.identifier}`;
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
        };
      }
      await execa('gh', ['repo', 'clone', evalFacts.repo, cwd]);
    } else {
      if (body.cwd === null) throw new HttpError(400, 'real 环境需要填写工作目录');
      cwd = path.resolve(body.cwd);
      if (!fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory()) {
        throw new HttpError(400, `工作目录不存在：${cwd}`);
      }
      if (body.workflow === 'lfg') {
        const input = task?.kind === 'lfg' ? task.input : body.input;
        if (input === null) throw new HttpError(400, '没有输入');
        initial = `/lfg ${input}`;
      } else {
        const source = task?.kind === 'ic' ? (task.source?.linear.identifier ?? null) : body.input;
        if (source === null) throw new HttpError(400, `task ${body.taskId ?? ''} 没有来源工单`);
        const identifier = issueIdentifier(source);
        if (identifier === null) {
          throw new HttpError(400, `不是 Linear 工单地址或工单编号：${source}`);
        }
        initial = `/ic ${identifier}`;
      }
    }
    return launch({
      liveId,
      variantId: body.variantId,
      environment: body.environment,
      workflow: body.workflow,
      input: task === null ? body.input : (body.input ?? null),
      taskId: body.taskId,
      cwd,
      claudeSessionId: sessionId,
      resumedFrom: null,
      sessionArgs: ['--session-id', sessionId, initial],
      projectDirName: liveId,
      driver: body.driver,
      persona: personaOf(task, body.workflow),
      eval: evalFacts,
      extraEnv,
      start: { ...start, initial },
    });
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
  function resumePersona(session: typeof sessions.$inferSelect): SimulatedPersona {
    if (session.runId !== null) {
      const run = db.select().from(runs).where(eq(runs.id, session.runId)).get();
      if (run !== undefined) return loadTask(db, run.taskId);
    }
    if (session.liveId !== null) {
      const live = row(session.liveId);
      if (live.taskId !== null) return loadTask(db, live.taskId);
      if (live.workflow !== null) {
        return { kind: live.workflow, persona: INPUT_PERSONA, hiddenRequirements: '' };
      }
    }
    return { kind: null, persona: RESUME_PERSONA, hiddenRequirements: '' };
  }

  function resumeDefaults(sessionId: string): ResumeDefaults {
    const session = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
    if (session === undefined) throw new HttpError(404, `session 不存在：${sessionId}`);
    let variantId: string | null = null;
    if (session.runId !== null) {
      variantId = db.select().from(runs).where(eq(runs.id, session.runId)).get()?.variantId ?? null;
    } else if (session.liveId !== null) {
      variantId = row(session.liveId).variantId;
    }
    return {
      sessionId,
      variantId,
      cwd: session.cwd,
      cwdExists: session.cwd !== null && fs.existsSync(session.cwd),
    };
  }

  // Contracts 14.5：环境固定为 real，工作目录为 session 记录的 cwd
  function resume(body: ResumeLiveBody): LiveDetail {
    const session = db.select().from(sessions).where(eq(sessions.id, body.sessionId)).get();
    if (session === undefined) throw new HttpError(404, `session 不存在：${body.sessionId}`);
    if (session.cwd === null) throw new HttpError(400, `session ${session.id} 没有记录工作目录`);
    if (!fs.statSync(session.cwd, { throwIfNoEntry: false })?.isDirectory()) {
      throw new HttpError(400, `工作目录不存在：${session.cwd}`);
    }
    if (body.variantId !== null) variants.runtimeEnv(body.variantId);
    const running = db
      .select({ id: liveSessions.id })
      .from(liveSessions)
      .where(
        sql`${liveSessions.claudeSessionId} = ${session.id} and ${liveSessions.status} = 'running'`,
      )
      .get();
    if (running !== undefined) {
      throw new HttpError(409, `session ${session.id} 正在交互 ${running.id} 中运行`);
    }
    const liveId = newId('l');
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
    const detailView = launch({
      liveId,
      variantId: body.variantId,
      environment: 'real',
      workflow: null,
      input: null,
      taskId: null,
      cwd: session.cwd,
      claudeSessionId: session.id,
      resumedFrom: session.id,
      sessionArgs: ['--resume', session.id],
      projectDirName: path.basename(path.dirname(jsonl)),
      driver: body.driver,
      persona: resumePersona(session),
      eval: null,
      extraEnv: {},
      start: { copiedFrom: copied ? session.filePath : null },
    });
    // 之后导入目标配置中的那份；原文件不动
    db.$client.transaction(() => {
      if (copied) {
        const oldDir = path.join(path.dirname(session.filePath), session.id);
        const newDir = path.join(path.dirname(jsonl), session.id);
        db.update(sessions).set({ filePath: jsonl }).where(eq(sessions.id, session.id)).run();
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
    return detailView;
  }

  return {
    list(): LiveSummary[] {
      return db
        .select()
        .from(liveSessions)
        .orderBy(
          sql`case when ${liveSessions.status} = 'running' then 0 else 1 end`,
          desc(liveSessions.createdAt),
        )
        .all()
        .map(summary);
    },
    get: detail,
    create,
    resume,
    resumeDefaults,
    hook(id: string, payload: HookPayload) {
      controllerOf(id).hook(payload);
    },
    setDriver(id: string, driver: LiveDriver) {
      const controller = controllerOf(id);
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
    controller(id: string): LiveController | null {
      row(id);
      return controllers.get(id) ?? null;
    },
    logFile(id: string): string {
      return path.join(liveDir(row(id).id), 'pty.log');
    },
    // 服务关闭：结束全部 PTY 进程
    async shutdown() {
      const ids = [...controllers.keys()];
      if (ids.length > 0) {
        db.update(liveSessions)
          .set({ error: '服务关闭，进程结束' })
          .where(inArray(liveSessions.id, ids))
          .run();
      }
      await Promise.all([...controllers.values()].map((c) => c.shutdown()));
    },
  };
}

export type Live = ReturnType<typeof createLive>;
