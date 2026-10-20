import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { execa } from 'execa';
import type { Db } from '../db/index.js';
import { liveProcesses, liveSessions, sessions } from '../db/schema.js';
import { events } from '../events.js';
import type { Live } from '../live/index.js';
import { codexHomeOf } from '../ingest/codex.js';
import { forgetImports, markCleared } from '../ingest/imports.js';
import { sessionTitles } from '../api/session-titles.js';
import { HttpError } from '../variants/errors.js';
import { claudeSessionFiles, deleteClaudeSessions } from './session-files.js';
import type { SessionAction, SessionActionPlan } from './session-views.js';

type SessionRow = typeof sessions.$inferSelect;

export interface SessionActionsDeps {
  db: Db;
  live: Live;
  // codex 命令（config.codexBin）：archive、unarchive、delete 不调用模型
  codexBin: string;
}

// codex unarchive 把 rollout 移回 sessions/YYYY/MM/DD/（按文件名中的日期，实测）
function unarchivedPath(codexHome: string, filePath: string): string {
  const name = path.basename(filePath);
  const m = /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(name);
  if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined)
    throw new Error(`rollout 文件名中没有日期：${name}`);
  return path.join(codexHome, 'sessions', m[1], m[2], m[3], name);
}

// Sessions 页面的删除与归档（Contracts 25.3、25.5）
export function createSessionActions({ db, live, codexBin }: SessionActionsDeps) {
  function rowsOf(ids: string[]): SessionRow[] {
    const rows = db.select().from(sessions).where(inArray(sessions.id, ids)).all();
    const missing = ids.filter((id) => !rows.some((r) => r.id === id));
    if (missing.length > 0) throw new HttpError(404, `session 不存在：${missing.join('、')}`);
    return ids.map((id) => rows.find((r) => r.id === id) as SessionRow);
  }

  function running(liveId: string): boolean {
    return (
      db
        .select({ id: liveProcesses.id })
        .from(liveProcesses)
        .where(and(eq(liveProcesses.liveId, liveId), eq(liveProcesses.status, 'running')))
        .get() !== undefined
    );
  }

  function liveItemOf(s: SessionRow): { id: string; title: string } | null {
    if (s.liveId === null) return null;
    const item = db
      .select({ id: liveSessions.id, title: liveSessions.title })
      .from(liveSessions)
      .where(eq(liveSessions.id, s.liveId))
      .get();
    if (item === undefined) throw new Error(`session ${s.id} 指向的交互项不存在：${s.liveId}`);
    return item;
  }

  function plan(action: SessionAction, ids: string[]): SessionActionPlan {
    const rows = rowsOf(ids);
    const titles = sessionTitles(db, ids);
    const blockers: SessionActionPlan['blockers'] = [];
    const block = (s: SessionRow, label: string) => {
      blockers.push({ sessionId: s.id, label: `${titles.get(s.id) ?? s.id}：${label}` });
    };
    // 清除只在管理表格中隐藏，任何 session 都可以清除（Contracts 25.1）
    if (action !== 'clear')
      for (const s of rows) {
        const item = liveItemOf(s);
        if (item !== null && running(item.id))
          block(s, `交互项「${item.title}」有运行中的进程用到这个 session，先结束进程`);
        if (s.variantBinding === 'run') block(s, 'run 的 session 随 run 保留，不能删除或归档');
        if ((action === 'archive' || action === 'unarchive') && s.engine === 'claude')
          block(s, 'Claude Code 没有单个 session 的归档，只能删除');
        if (action === 'archive' && s.archivedAt !== null) block(s, '已经归档');
        if (action === 'unarchive' && s.archivedAt === null) block(s, '没有归档');
      }
    return {
      action,
      sessions: rows.map((s) => ({
        id: s.id,
        title: titles.get(s.id) ?? null,
        engine: s.engine,
        // 清除不动磁盘上的文件
        files:
          action === 'clear' ? [] : s.engine === 'claude' ? claudeSessionFiles(s) : [s.filePath],
      })),
      liveItems: action === 'delete' ? rows.flatMap((s) => liveItemOf(s) ?? []) : [],
      blockers,
    };
  }

  // 以这个 session 的 CODEX_HOME 运行 codex 的命令；失败时以原文报错（name 为标题），dashboard 中的记录不变
  async function codex(args: string[], s: SessionRow, name: string) {
    const result = await execa(codexBin, args, {
      env: { CODEX_HOME: codexHomeOf(s.filePath) },
      reject: false,
      stdin: 'ignore',
      all: true,
    });
    if (result.exitCode !== 0) {
      throw new HttpError(
        500,
        `${name}：codex ${args.join(' ')} 失败（退出码 ${String(result.exitCode)}）：\n${result.all}`,
      );
    }
  }

  async function execute(action: SessionAction, ids: string[]): Promise<SessionActionPlan> {
    const p = plan(action, ids);
    if (p.blockers.length > 0) {
      throw new HttpError(
        409,
        `不能${actionLabel[action]}：\n${p.blockers.map((b) => `- ${b.label}`).join('\n')}`,
      );
    }
    const names = new Map(p.sessions.map((s) => [s.id, s.title ?? s.id]));
    for (const s of rowsOf(ids)) {
      const name = names.get(s.id) ?? s.id;
      if (action === 'clear') {
        // 只记下清除时间：dashboard 中的数据与磁盘上的文件都保留，用到它的 run、分析、Live 项照常读取
        markCleared(db, s.id);
        console.info(`[sessions] 清除 ${s.engine} session ${s.id}（${s.filePath}）`);
      } else if (action === 'delete') {
        // Codex 的 rollout 由 codex delete 永久删除；Claude Code 的文件与记录由 dashboard 删除
        if (s.engine === 'codex') await codex(['delete', '--force', s.id], s, name);
        if (s.liveId !== null) live.removeItem(s.liveId);
        if (s.engine === 'claude') deleteClaudeSessions(db, [s]);
        else {
          db.delete(sessions).where(eq(sessions.id, s.id)).run();
          forgetImports(db, [s.id]);
        }
        console.info(`[sessions] 删除 ${s.engine} session ${s.id}（${s.filePath}）`);
      } else if (action === 'archive') {
        await codex(['archive', s.id], s, name);
        const archived = path.join(
          codexHomeOf(s.filePath),
          'archived_sessions',
          path.basename(s.filePath),
        );
        db.update(sessions)
          .set({ archivedAt: new Date(), filePath: archived })
          .where(eq(sessions.id, s.id))
          .run();
      } else {
        await codex(['unarchive', s.id], s, name);
        db.update(sessions)
          .set({ archivedAt: null, filePath: unarchivedPath(codexHomeOf(s.filePath), s.filePath) })
          .where(eq(sessions.id, s.id))
          .run();
      }
      events.publish({ type: 'session.updated', sessionId: s.id });
    }
    return p;
  }

  return { plan, execute };
}

const actionLabel: Record<SessionAction, string> = {
  clear: '清除',
  delete: '删除',
  archive: '归档',
  unarchive: '恢复',
};

export type SessionActions = ReturnType<typeof createSessionActions>;
