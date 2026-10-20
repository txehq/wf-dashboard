import fs from 'node:fs';
import path from 'node:path';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  type LiveEngine,
  liveEvents,
  liveProcesses,
  liveSessions,
  type MagiDeployStep,
  magiDeploys,
  runs,
} from '../db/schema.js';
import { events } from '../events.js';
import type { Live } from '../live/index.js';
import type { LiveDetail } from '../live/views.js';
import { HttpError } from '../variants/errors.js';
import type { Variants } from '../variants/index.js';
import {
  aheadBehind,
  exec,
  initialWorktreeSteps,
  MAGI_BRANCH,
  MAIN_BRANCH,
  runWorktreeStep,
  uncommittedFiles,
  worktreeReady,
} from './git.js';
import type {
  MagiAgentView,
  MagiDeployView,
  MagiOpenBody,
  MagiSessionView,
  WorktreeStep,
} from './views.js';

export interface MagiAgentDeps {
  db: Db;
  live: Live;
  // variant 的配置要构建成功才能用（Contracts 23.3）
  variants: Variants;
  // 主仓库：正在运行的 dashboard 所在的目录，MAGI.md 从这里读取，部署合并进它的 main
  repoDir: string;
  worktree: string;
  // 部署第 3 步在 worktree 中运行的检查
  check: string[];
  // data/：部署的日志在 data/magi-agent/，数据库备份在 data/backups/
  dataDir: string;
  // 部署的最后一步：服务以退出码 75 结束，由 pnpm start 的守护进程重新构建并启动
  restart: () => void;
}

// 部署第 3 步的端口（Contracts 23.5），与正在运行的 dashboard 和各 worker 的端口错开
const CHECK_PORTS = { WFD_PORT: '7398', WFD_WEB_PORT: '5298' };

// 失败时返回的检查输出：日志的最后这么多行，完整输出在日志文件中
const CHECK_TAIL_LINES = 80;

// 有这些状态的 run 时不部署（Contracts 23.5 第 2 步）
const ACTIVE_RUN_STATUSES = ['queued', 'preparing', 'running', 'grading'] as const;

// 部署接口的响应发出后到服务结束之间的间隔（实测 Claude Code 在服务立即结束时来不及把 curl 的返回记进会话）
const RESTART_DELAY_MS = 3000;

function deployStep(id: string, label: string): MagiDeployStep {
  return { id, label, status: 'pending', output: null, startedAt: null, endedAt: null };
}

const stamp = (at: Date) =>
  at
    .toISOString()
    .replaceAll(':', '-')
    .replace(/\.\d+Z$/, 'Z');

// worktree 与子进程不继承运行中的 dashboard 的 WFD_* 设置（数据目录、端口、替身命令），各自用默认值
function cleanEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith('WFD_'),
    ),
  );
}

export function createMagiAgent(deps: MagiAgentDeps) {
  const { db, live } = deps;
  let worktreeState: { state: 'preparing' | 'failed' | null; steps: WorktreeStep[] } = {
    state: null,
    steps: initialWorktreeSteps(),
  };
  let preparing: Promise<boolean> | null = null;
  // worktree 准备完成后在后台启动失败的原文
  let startError: string | null = null;
  let deploying = false;

  // 上次服务退出时正在执行的部署
  db.update(magiDeploys)
    .set({ status: 'failed', error: '服务重启中断', endedAt: new Date() })
    .where(eq(magiDeploys.status, 'running'))
    .run();

  const publish = () => {
    events.publish({ type: 'magi.updated' });
  };

  // 每次启动与 resume 时读取主仓库中的这一份（Contracts 23.4）
  const instructions = () => fs.readFileSync(path.join(deps.repoDir, 'agent/MAGI.md'), 'utf8');

  // 全部 Magi Agent 的会话（包括已关闭的），最近的在前（Contracts 23.6 弹出框的会话选择）
  function sessionsList(): MagiSessionView[] {
    return db
      .select({
        id: liveSessions.id,
        title: liveSessions.title,
        engine: liveSessions.engine,
        config: liveSessions.agentConfig,
        updatedAt: liveSessions.updatedAt,
      })
      .from(liveSessions)
      .where(eq(liveSessions.purpose, 'agent'))
      .orderBy(desc(liveSessions.updatedAt))
      .all()
      .map((s) => {
        if (s.config === null) throw new Error(`Magi Agent 的项 ${s.id} 没有记下配置`);
        return {
          ...s,
          config: s.config,
          updatedAt: s.updatedAt.getTime(),
          running: live.running(s.id),
        };
      });
  }

  // Codex 只有本机配置；variant 的配置要按当前内容构建成功（Contracts 23.3、23.6），不满足时以原文拒绝
  function checkConfig(engine: LiveEngine, config: string) {
    if (config === 'local') return;
    if (engine === 'codex') {
      throw new HttpError(400, 'Codex 的 Magi Agent 只有本机配置');
    }
    deps.variants.runtimeEnv(config);
  }

  // 第一次打开时建 worktree 并 pnpm install（Contracts 23.2），进度在 worktreeState 中；同时打开多次时共用一次准备
  function ensureWorktree(): Promise<boolean> {
    if (worktreeReady(deps.worktree)) return Promise.resolve(true);
    if (preparing !== null) return preparing;
    preparing = prepareWorktree().finally(() => {
      preparing = null;
    });
    return preparing;
  }

  async function prepareWorktree(): Promise<boolean> {
    worktreeState = { state: 'preparing', steps: initialWorktreeSteps() };
    publish();
    for (const step of worktreeState.steps) {
      step.status = 'running';
      publish();
      const result = await runWorktreeStep(step.id, deps.repoDir, deps.worktree);
      step.output = result.output;
      step.status = result.ok ? 'done' : 'failed';
      if (!result.ok) {
        worktreeState.state = 'failed';
        publish();
        return false;
      }
    }
    worktreeState = { state: null, steps: worktreeState.steps };
    publish();
    return true;
  }

  // worktree 准备好之后启动或 resume；还在准备时先返回这一项，准备完成后在后台启动。后台启动失败的原文记在 startError
  function startWhenReady(liveId: string, message: string | null): LiveDetail {
    if (worktreeReady(deps.worktree) && preparing === null) {
      return live.launchAgent(liveId, { instructions: instructions(), message });
    }
    startError = null;
    void ensureWorktree()
      .then((ok) => {
        if (ok && !live.running(liveId)) {
          live.launchAgent(liveId, { instructions: instructions(), message });
        }
      })
      .then(
        () => undefined,
        (error: unknown) => {
          startError = `启动 ${liveId} 失败：${error instanceof Error ? error.message : String(error)}`;
          publish();
        },
      );
    return live.get(liveId);
  }

  function requireAgent(liveId: string): LiveDetail {
    const item = live.get(liveId);
    if (item.purpose !== 'agent') {
      throw new HttpError(400, `交互 ${liveId} 不是 Magi Agent 的会话`);
    }
    return item;
  }

  function createSession(engine: LiveEngine, config: string): LiveDetail {
    checkConfig(engine, config);
    const item = live.createAgentItem({ engine, config, cwd: deps.worktree });
    publish();
    return startWhenReady(item.id, null);
  }

  function deployView(row: typeof magiDeploys.$inferSelect): MagiDeployView {
    return {
      id: row.id,
      liveId: row.liveId,
      engine: row.engine,
      status: row.status,
      steps: row.steps,
      error: row.error,
      commit: row.commit,
      startedAt: row.startedAt.getTime(),
      endedAt: row.endedAt === null ? null : row.endedAt.getTime(),
    };
  }

  function deployRow(id: number) {
    const row = db.select().from(magiDeploys).where(eq(magiDeploys.id, id)).get();
    if (row === undefined) throw new HttpError(404, `部署不存在：${String(id)}`);
    return row;
  }

  // 第 2 步：除 Magi Agent 自己之外运行中的交互进程，与 queued、preparing、running、grading 的 run
  function busy(): string[] {
    const items = db
      .select({ id: liveSessions.id, title: liveSessions.title })
      .from(liveProcesses)
      .innerJoin(liveSessions, eq(liveSessions.id, liveProcesses.liveId))
      .where(and(eq(liveProcesses.status, 'running'), ne(liveSessions.purpose, 'agent')))
      .all();
    const active = db
      .select({ id: runs.id, status: runs.status })
      .from(runs)
      .where(inArray(runs.status, [...ACTIVE_RUN_STATUSES]))
      .all();
    return [
      ...items.map((i) => `交互「${i.title}」（${i.id}）有运行中的进程`),
      ...active.map((r) => `run ${r.id} 的状态是 ${r.status}`),
    ];
  }

  async function runCheck(logFile: string): Promise<{ ok: boolean; output: string }> {
    const [file, ...args] = deps.check;
    if (file === undefined) throw new Error('部署的检查命令为空');
    const result = await exec(deps.worktree, file, args, { ...cleanEnv(), ...CHECK_PORTS });
    fs.appendFileSync(logFile, `$ ${deps.check.join(' ')}（${deps.worktree}）\n${result.output}\n`);
    const tail = result.output.split('\n').slice(-CHECK_TAIL_LINES).join('\n');
    return {
      ok: result.ok,
      output: result.ok
        ? `通过，完整输出见 ${logFile}`
        : `${deps.check.join(' ')} 失败（完整输出见 ${logFile}），最后 ${String(CHECK_TAIL_LINES)} 行：\n${tail}`,
    };
  }

  async function mergeCheck(): Promise<{ ok: boolean; output: string }> {
    const head = await exec(deps.repoDir, 'git', ['symbolic-ref', '--short', 'HEAD']);
    if (!head.ok || head.output.trim() !== MAIN_BRANCH) {
      return {
        ok: false,
        output: `主仓库 ${deps.repoDir} 当前不在 ${MAIN_BRANCH} 分支上：${head.output.trim()}`,
      };
    }
    const dirty = await exec(deps.repoDir, 'git', [
      'status',
      '--porcelain',
      '--untracked-files=no',
    ]);
    if (!dirty.ok || dirty.output.trim() !== '') {
      return {
        ok: false,
        output: `主仓库 ${deps.repoDir} 有未提交的改动（未跟踪的文件除外）：\n${dirty.output}`,
      };
    }
    const tree = await exec(deps.repoDir, 'git', [
      'merge-tree',
      '--write-tree',
      '--name-only',
      MAIN_BRANCH,
      MAGI_BRANCH,
    ]);
    if (!tree.ok) {
      return {
        ok: false,
        output: `合并进 ${MAIN_BRANCH} 有冲突，先把 ${MAIN_BRANCH} 合并进 ${MAGI_BRANCH} 分支并解决冲突。git merge-tree 的输出（第一行是合并结果的 tree，之后是有冲突的文件）：\n${tree.output}`,
      };
    }
    return { ok: true, output: '没有冲突' };
  }

  // 部署（Contracts 23.5）：按顺序执行六步，任何一步失败都停下并以原文返回；每一步的进度经 SSE magi.deploy 推送
  async function deploy(liveId: string): Promise<MagiDeployView> {
    const item = requireAgent(liveId);
    if (deploying) throw new HttpError(409, '已经有一次部署在进行');
    deploying = true;
    const startedAt = new Date();
    const logFile = path.join(deps.dataDir, 'magi-agent', `deploy-${stamp(startedAt)}.log`);
    // 日志从部署开始时就有：每一步的结果追加在后面，第 3 步另有检查的完整输出
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, `部署 ${item.title}（${liveId}），${startedAt.toISOString()}\n`);
    const steps = [
      deployStep('clean', 'worktree 没有未提交的改动'),
      deployStep('idle', '没有别的运行中的交互进程与 run'),
      deployStep('check', `在 worktree 中运行 ${deps.check.join(' ')}`),
      deployStep('merge-check', `检查合并进 ${MAIN_BRANCH} 有没有冲突`),
      deployStep('merge', `在主仓库 git merge --no-ff ${MAGI_BRANCH}`),
      deployStep('restart', '备份数据库并重新启动'),
    ];
    const id = db
      .insert(magiDeploys)
      .values({
        liveId,
        engine: item.engine,
        status: 'running',
        steps,
        logFile,
        startedAt,
      })
      .returning({ id: magiDeploys.id })
      .get().id;
    const save = (values: Partial<typeof magiDeploys.$inferInsert>) => {
      db.update(magiDeploys)
        .set({ ...values, steps })
        .where(eq(magiDeploys.id, id))
        .run();
      events.publish({ type: 'magi.deploy', deployId: id, status: deployRow(id).status });
    };
    let commit: string | null = null;
    let backupFile: string | null = null;
    const run = async (stepId: string): Promise<{ ok: boolean; output: string }> => {
      if (stepId === 'clean') {
        const files = await uncommittedFiles(deps.worktree);
        return files.length === 0
          ? { ok: true, output: '没有未提交的改动' }
          : {
              ok: false,
              output: `worktree ${deps.worktree} 有未提交的改动：\n${files.join('\n')}`,
            };
      }
      if (stepId === 'idle') {
        const list = busy();
        return list.length === 0
          ? { ok: true, output: '没有' }
          : {
              ok: false,
              output: `有别的进程或 run 在运行，等它们结束后再部署：\n${list.join('\n')}`,
            };
      }
      if (stepId === 'check') return runCheck(logFile);
      if (stepId === 'merge-check') return mergeCheck();
      if (stepId === 'merge') {
        const merged = await exec(deps.repoDir, 'git', [
          'merge',
          '--no-ff',
          MAGI_BRANCH,
          '-m',
          `Magi Agent 部署：合并 ${MAGI_BRANCH}`,
        ]);
        if (!merged.ok) return merged;
        const head = await exec(deps.repoDir, 'git', ['rev-parse', 'HEAD']);
        if (!head.ok) return head;
        commit = head.output.trim();
        return { ok: true, output: commit };
      }
      // 数据库备份用 SQLite 的 backup（.backup），之后记下部署后 resume，服务以退出码 75 结束
      backupFile = path.join(deps.dataDir, 'backups', `db-${stamp(new Date())}.sqlite`);
      fs.mkdirSync(path.dirname(backupFile), { recursive: true });
      await db.$client.backup(backupFile);
      return { ok: true, output: `数据库备份在 ${backupFile}` };
    };
    try {
      for (const step of steps) {
        step.status = 'running';
        step.startedAt = Date.now();
        save({});
        const result = await run(step.id);
        step.output = result.output;
        step.endedAt = Date.now();
        step.status = result.ok ? 'done' : 'failed';
        fs.appendFileSync(logFile, `[${step.status}] ${step.label}：${result.output}\n`);
        if (!result.ok) {
          const error = `${step.label}失败：${result.output}`;
          save({ status: 'failed', error, endedAt: new Date() });
          throw new HttpError(409, error);
        }
        save({ commit, backupFile });
      }
      save({ status: 'restarting' });
    } finally {
      deploying = false;
    }
    return deployView(deployRow(id));
  }

  return {
    view: async (): Promise<MagiAgentView> => {
      const ready = worktreeReady(deps.worktree) && preparing === null;
      const counts = ready ? await aheadBehind(deps.repoDir) : null;
      const files = ready ? await uncommittedFiles(deps.worktree) : null;
      const latest = db.select().from(magiDeploys).orderBy(desc(magiDeploys.id)).get();
      return {
        worktree: {
          path: deps.worktree,
          branch: MAGI_BRANCH,
          state: ready ? 'ready' : (worktreeState.state ?? 'missing'),
          steps: worktreeState.steps,
          ahead: counts?.ahead ?? null,
          behind: counts?.behind ?? null,
          uncommitted: files?.length ?? null,
          startError,
        },
        sessions: sessionsList(),
        deploy: latest === undefined ? null : deployView(latest),
      };
    },

    // 打开（Contracts 23.6）：liveId 为空时新建一个会话；否则打开所选的会话（引擎与配置要与所选的相同），
    // 没有运行中的进程时 resume
    open(body: MagiOpenBody): LiveDetail {
      if (body.liveId === null) return createSession(body.engine, body.config);
      const item = requireAgent(body.liveId);
      if (item.engine !== body.engine || item.agentConfig !== body.config) {
        throw new HttpError(
          400,
          `会话 ${item.id} 的引擎与配置是 ${item.engine}、${String(item.agentConfig)}，不是 ${body.engine}、${body.config}`,
        );
      }
      if (live.running(item.id)) return live.get(item.id);
      return startWhenReady(item.id, null);
    },

    // resume 一个 Magi Agent 的会话，同样注入 MAGI.md
    resume(liveId: string): LiveDetail {
      requireAgent(liveId);
      return startWhenReady(liveId, null);
    },

    deploy,

    // 部署后的 restart：在部署接口的响应发出之后调用；等几秒，agent 的终端先把接口的返回记进会话
    restart: () => {
      setTimeout(deps.restart, RESTART_DELAY_MS);
    },

    deployLog(id: number): string {
      return fs.readFileSync(deployRow(id).logFile, 'utf8');
    },

    // 服务启动后（监听端口之后，hook 需要服务的地址）：看到"部署后 resume"时 resume 这个会话，消息为"部署完成：<commit>"
    resumeAfterDeploy() {
      const pending = db
        .select()
        .from(magiDeploys)
        .where(eq(magiDeploys.status, 'restarting'))
        .orderBy(desc(magiDeploys.id))
        .all();
      for (const row of pending) {
        db.update(magiDeploys)
          .set({ status: 'done', endedAt: new Date() })
          .where(eq(magiDeploys.id, row.id))
          .run();
        db.insert(liveEvents)
          .values({
            liveId: row.liveId,
            processId: null,
            at: new Date(),
            kind: 'deploy',
            payload: { deployId: row.id, commit: row.commit, backupFile: row.backupFile },
          })
          .run();
        events.publish({ type: 'magi.deploy', deployId: row.id, status: 'done' });
      }
      const last = pending[0];
      if (last !== undefined) startWhenReady(last.liveId, `部署完成：${last.commit ?? ''}`);
    },
  };
}

export type MagiAgent = ReturnType<typeof createMagiAgent>;
