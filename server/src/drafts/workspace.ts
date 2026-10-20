import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { parseDocument } from 'yaml';
import type { Db } from '../db/index.js';
import { liveSessions, workflowDrafts } from '../db/schema.js';
import { events } from '../events.js';
import { HttpError } from '../variants/errors.js';
import { listSkillFiles, resolveSkillPath } from '../variants/skills.js';
import { requiredSkills, WorkflowDefinition } from '../workflows/schema.js';
import type { Drafts } from './index.js';
import { previousSnapshot, recordSnapshot, savedCopy } from './snapshots.js';
import type {
  WorkspaceAgainst,
  WorkspaceDiffView,
  WorkspaceEvent,
  WorkspaceFileStatus,
  WorkspaceFileView,
  WorkspaceStageStatus,
  WorkspaceView,
} from './views.js';

// 比较工作目录的间隔：与 ingest 的 watcher 相同按间隔比较，不依赖 FSEvents（大量写入时会整段丢弃事件）
const POLL_MS = 250;
// 上一版的快照：每秒比较一次，文件改动停下 5 秒后记下（Contracts 26.4）
const SNAPSHOT_POLL_MS = 1000;
export const SNAPSHOT_QUIET_MS = 5000;

// 一项的 src/skills 最近一次变化：签名、变化的时间、这次变化之后是否已经判断过要不要记快照
interface Quiet {
  sig: string;
  changedAt: number;
  recorded: boolean;
}

const atOf = (found: { at: number } | null) => (found === null ? null : { at: found.at });

// SSE 的一个连接
export interface WorkspaceConnection {
  send(event: WorkspaceEvent): void;
  // 服务端结束这个连接
  end(): void;
}

interface Watcher {
  src: string;
  workflowYaml: string;
  // 文件（相对 src/）与 workflow.yaml 的 mtime、大小与 inode
  snapshot: Map<string, string>;
  connections: Set<WorkspaceConnection>;
  timer: ReturnType<typeof setInterval>;
}

const WORKFLOW_KEY = 'workflow.yaml';

// src/skills 下的文件（相对 src/）；准备中还没有复制出 src 时为空。符号链接不是文件，不列出
const filesOf = (src: string | null) =>
  src !== null && fs.existsSync(path.join(src, 'skills')) ? listSkillFiles(src) : [];

function readIn(src: string | null, file: string): Buffer | null {
  if (src === null) return null;
  const absolute = resolveSkillPath(src, file);
  return fs.existsSync(absolute) ? fs.readFileSync(absolute) : null;
}

function statusOf(work: Buffer | null, base: Buffer | null): WorkspaceFileStatus | null {
  if (work === null) return base === null ? null : 'removed';
  if (base === null) return 'added';
  return work.equals(base) ? 'unchanged' : 'modified';
}

// workflow.yaml 解析失败是要显示给人的结果（Contracts 26.2），以原文返回
function readWorkflow(file: string): { definition: WorkflowDefinition } | { error: string } {
  if (!fs.existsSync(file)) return { error: `没有 workflow.yaml：${file}` };
  const doc = parseDocument(fs.readFileSync(file, 'utf8'));
  if (doc.errors.length > 0) {
    return {
      error: `workflow.yaml 不是合法的 YAML：${doc.errors.map((e) => e.message).join('；')}`,
    };
  }
  const result = WorkflowDefinition.safeParse(doc.toJS());
  if (!result.success) {
    return { error: `workflow.yaml 不符合 workflow schema：${result.error.message}` };
  }
  return { definition: result.data };
}

function signature(file: string): string | null {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (stat === undefined) return null;
  return `${String(stat.mtimeMs)}:${String(stat.size)}:${String(stat.ino)}`;
}

function snapshotOf(src: string, workflowYaml: string): Map<string, string> {
  const snapshot = new Map<string, string>();
  for (const file of filesOf(src)) {
    const sig = signature(path.join(src, file));
    if (sig !== null) snapshot.set(file, sig);
  }
  const yamlSig = signature(workflowYaml);
  if (yamlSig !== null) snapshot.set(WORKFLOW_KEY, yamlSig);
  return snapshot;
}

// 设计与优化会话的 workflow 面板（Contracts 26.4）：工作目录中 src/skills 与 workflow.yaml 的只读视图与监视
export function createWorkspace({ db, drafts }: { db: Db; drafts: Drafts }) {
  const watchers = new Map<string, Watcher>();

  function tree(liveId: string): WorkspaceView {
    const { draft, layout, base, baseSrc } = drafts.workspaceOf(liveId);
    const paths = [...new Set([...filesOf(layout.src), ...filesOf(baseSrc)])].sort();
    // 列出之后、读取之前被 agent 删除的文件不再列出
    const files = paths.flatMap((file) => {
      const work = readIn(layout.src, file);
      const status = statusOf(work, readIn(baseSrc, file));
      if (status === null) return [];
      const stat =
        work === null
          ? undefined
          : fs.lstatSync(path.join(layout.src, file), { throwIfNoEntry: false });
      return [{ path: file, status, mtimeMs: stat?.mtimeMs ?? null }];
    });
    const parsed = readWorkflow(layout.workflowYaml);
    const stageStatus = (skill: string): WorkspaceStageStatus => {
      const prefix = `skills/${skill}/`;
      const inside = files.filter((f) => f.path.startsWith(prefix));
      if (inside.every((f) => f.status === 'removed')) return 'missing';
      if (inside.every((f) => f.status === 'added')) return 'added';
      return inside.some((f) => f.status !== 'unchanged') ? 'modified' : 'unchanged';
    };
    return {
      draftId: draft.id,
      mode: draft.mode,
      analysisId: draft.analysisId,
      root: path.relative(layout.dir, layout.skills),
      base,
      workflow:
        'error' in parsed
          ? parsed
          : {
              definition: parsed.definition,
              stages: requiredSkills(parsed.definition).map((id, i) => ({
                id,
                entry: i === 0,
                status: stageStatus(id),
              })),
            },
      files,
      against: {
        saved: atOf(savedCopy(layout)),
        previous: atOf(previousSnapshot(layout)),
      },
    };
  }

  function file(liveId: string, relativePath: string): WorkspaceFileView {
    const { layout, baseSrc } = drafts.workspaceOf(liveId);
    const work = readIn(layout.src, relativePath);
    const binary = work?.includes(0) === true;
    return {
      path: relativePath,
      status: statusOf(work, readIn(baseSrc, relativePath)),
      content: work === null || binary ? null : work.toString('utf8'),
      binary,
    };
  }

  // 对比的对象的根（其下是 skills/）：底子为底子的 src/（没有时为 null，全部算新增）；上次保存与上一版不存在时 409
  function againstRoot(liveId: string, against: WorkspaceAgainst): string | null {
    const { draft, layout, baseSrc } = drafts.workspaceOf(liveId);
    if (against === 'base') return baseSrc;
    if (against === 'saved') {
      const saved = savedCopy(layout);
      if (saved === null) throw new HttpError(409, `草稿 ${draft.id} 还没有保存过`);
      return saved.root;
    }
    const previous = previousSnapshot(layout);
    if (previous === null) {
      throw new HttpError(409, '还没有上一版：文件改动停下 5 秒后才记下一份');
    }
    return previous.root;
  }

  function diff(
    liveId: string,
    relativePath: string,
    against: WorkspaceAgainst,
  ): WorkspaceDiffView {
    const { layout } = drafts.workspaceOf(liveId);
    const work = readIn(layout.src, relativePath);
    const base = readIn(againstRoot(liveId, against), relativePath);
    const oldContent = base?.toString('utf8') ?? '';
    const newContent = work?.toString('utf8') ?? '';
    return {
      path: relativePath,
      against,
      status: statusOf(work, base),
      oldContent,
      newContent,
      patch: createTwoFilesPatch(
        base === null ? '/dev/null' : `a/${relativePath}`,
        work === null ? '/dev/null' : `b/${relativePath}`,
        oldContent,
        newContent,
      ),
    };
  }

  function release(liveId: string) {
    const watcher = watchers.get(liveId);
    if (watcher === undefined) return;
    clearInterval(watcher.timer);
    watchers.delete(liveId);
    for (const connection of watcher.connections) connection.end();
  }

  function broadcast(watcher: Watcher, event: WorkspaceEvent) {
    for (const connection of watcher.connections) connection.send(event);
  }

  function poll(watcher: Watcher) {
    const next = snapshotOf(watcher.src, watcher.workflowYaml);
    const changed = [...new Set([...watcher.snapshot.keys(), ...next.keys()])]
      .filter((key) => watcher.snapshot.get(key) !== next.get(key))
      .sort();
    watcher.snapshot = next;
    if (changed.length === 0) return;
    broadcast(watcher, {
      type: 'changed',
      paths: changed.filter((key) => key !== WORKFLOW_KEY),
      workflow: changed.includes(WORKFLOW_KEY),
    });
  }

  // 项被关闭或删除（两者都发布 live.updated）：通知页面并释放监视器
  const unsubscribe = events.subscribe((event) => {
    if (event.type !== 'live.updated') return;
    const watcher = watchers.get(event.liveId);
    if (watcher === undefined) return;
    const item = db
      .select({ hiddenAt: liveSessions.hiddenAt })
      .from(liveSessions)
      .where(eq(liveSessions.id, event.liveId))
      .get();
    if (item?.hiddenAt === null) return;
    broadcast(watcher, { type: 'closed', reason: item === undefined ? 'deleted' : 'hidden' });
    release(event.liveId);
  });

  // 上一版的快照（Contracts 26.4、28.4）：没有关闭、准备完成的设计与优化项，每秒比较 src/skills 下文件的 mtime 与大小，
  // 最后一次变化之后停下 5 秒时记下一份（与最新一份相同时不记）。与 SSE 的监视器分开，没有页面打开时也记；
  // 服务启动后第一次看到的项从这时算起
  const quiet = new Map<string, Quiet>();
  function recordSnapshots() {
    const open = db
      .select({ liveId: liveSessions.id })
      .from(workflowDrafts)
      .innerJoin(liveSessions, eq(liveSessions.id, workflowDrafts.liveId))
      .where(and(inArray(workflowDrafts.status, ['open', 'saved']), isNull(liveSessions.hiddenAt)))
      .all();
    const now = Date.now();
    for (const liveId of [...quiet.keys()]) {
      if (!open.some((o) => o.liveId === liveId)) quiet.delete(liveId);
    }
    for (const { liveId } of open) {
      const { layout } = drafts.workspaceOf(liveId);
      const sig = [...snapshotOf(layout.src, layout.workflowYaml)]
        .filter(([key]) => key !== WORKFLOW_KEY)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n');
      const state = quiet.get(liveId);
      if (state?.sig !== sig) {
        quiet.set(liveId, { sig, changedAt: now, recorded: false });
        continue;
      }
      if (state.recorded || now - state.changedAt < SNAPSHOT_QUIET_MS) continue;
      state.recorded = true;
      recordSnapshot(layout, now);
    }
  }
  const snapshotTimer = setInterval(() => {
    // 列出或复制的中途 agent 删掉了目录（ENOENT）是正常的改动：这一项的签名随之变化，停下 5 秒后重新记。
    // 其他错误照常抛出
    try {
      recordSnapshots();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }, SNAPSHOT_POLL_MS);

  return {
    tree,
    file,
    diff,

    // 一个页面开始监视这一项；返回断开时调用的函数（重复调用只算一次）。同一项的连接共用一个监视器，
    // 最后一个断开时释放。没有草稿的项 404（在 SSE 开始之前抛出）
    watch(liveId: string, connection: WorkspaceConnection): () => void {
      let watcher = watchers.get(liveId);
      if (watcher === undefined) {
        const { layout } = drafts.workspaceOf(liveId);
        // 已关闭的项不再监视（EventSource 在 closed 之后自动重连时得到这个错误，不再重试）
        const item = db
          .select({ hiddenAt: liveSessions.hiddenAt })
          .from(liveSessions)
          .where(eq(liveSessions.id, liveId))
          .get();
        if (item?.hiddenAt !== null) throw new HttpError(409, `交互 ${liveId} 已关闭`);
        const created: Watcher = {
          src: layout.src,
          workflowYaml: layout.workflowYaml,
          snapshot: snapshotOf(layout.src, layout.workflowYaml),
          connections: new Set(),
          // 不能从定时器中抛出（成为 uncaught exception，整个服务退出）：出错时把原文发给页面并释放
          timer: setInterval(() => {
            try {
              poll(created);
            } catch (error) {
              broadcast(created, {
                type: 'failed',
                message: error instanceof Error ? error.message : String(error),
              });
              release(liveId);
            }
          }, POLL_MS),
        };
        watcher = created;
        watchers.set(liveId, watcher);
      }
      watcher.connections.add(connection);
      const own = watcher;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        own.connections.delete(connection);
        if (own.connections.size === 0 && watchers.get(liveId) === own) release(liveId);
      };
    },

    // GET /api/diagnostics
    diagnostics() {
      let connections = 0;
      for (const watcher of watchers.values()) connections += watcher.connections.size;
      return { watchers: watchers.size, connections };
    },

    shutdown() {
      clearInterval(snapshotTimer);
      unsubscribe();
      for (const liveId of [...watchers.keys()]) release(liveId);
    },
  };
}

export type Workspace = ReturnType<typeof createWorkspace>;
