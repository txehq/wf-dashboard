import fs from 'node:fs';
import path from 'node:path';
import { and, eq, inArray } from 'drizzle-orm';
import { execa } from 'execa';
import { config } from '../config.js';
import type { Db } from '../db/index.js';
import { liveProcesses, liveSessions, sessions } from '../db/schema.js';
import { events } from '../events.js';
import type { Live } from '../live/index.js';
import { codexHomeOf } from '../ingest/codex.js';
import { forgetImports, markCleared } from '../ingest/imports.js';
import { sessionTitles } from '../api/session-titles.js';
import { deleteRemoteFiles, remoteClaudeFiles, remoteCodexDelete } from '../remote/delete.js';
import { createHosts } from '../remote/hosts.js';
import { HttpError } from '../variants/errors.js';
import { claudeSessionFiles, deleteClaudeSessions } from './session-files.js';
import type { SessionAction, SessionActionPlan } from './session-views.js';

type SessionRow = typeof sessions.$inferSelect;

export interface SessionActionsDeps {
  db: Db;
  live: Live;
  // codex command (config.codexBin): archive, unarchive and delete do not call a model
  codexBin: string;
}

// codex unarchive moves the rollout back to sessions/YYYY/MM/DD/ (by the date in the file name, observed)
function unarchivedPath(codexHome: string, filePath: string): string {
  const name = path.basename(filePath);
  const m = /^rollout-(\d{4})-(\d{2})-(\d{2})T/.exec(name);
  if (m?.[1] === undefined || m[2] === undefined || m[3] === undefined)
    throw new Error(`No date in rollout file name: ${name}`);
  return path.join(codexHome, 'sessions', m[1], m[2], m[3], name);
}

// Deleting and archiving on the Sessions page (Contracts 25.3, 25.5)
export function createSessionActions({ db, live, codexBin }: SessionActionsDeps) {
  // Deleting a session on an SSH host also deletes the remote original files (Contracts 31.6)
  const hosts = createHosts({ db, sshHostsFile: config.sshHostsFile });
  function rowsOf(ids: string[]): SessionRow[] {
    const rows = db.select().from(sessions).where(inArray(sessions.id, ids)).all();
    const missing = ids.filter((id) => !rows.some((r) => r.id === id));
    if (missing.length > 0) throw new HttpError(404, `Session not found: ${missing.join(', ')}`);
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
    if (item === undefined)
      throw new Error(`Interactive item of session ${s.id} not found: ${s.liveId}`);
    return item;
  }

  async function plan(action: SessionAction, ids: string[]): Promise<SessionActionPlan> {
    const rows = rowsOf(ids);
    const titles = sessionTitles(db, ids);
    const blockers: SessionActionPlan['blockers'] = [];
    const block = (s: SessionRow, label: string) => {
      blockers.push({ sessionId: s.id, label: `${titles.get(s.id) ?? s.id}: ${label}` });
    };
    // Clearing only hides a session from the management table; any session can be cleared (Contracts 25.1)
    if (action !== 'clear')
      for (const s of rows) {
        const item = liveItemOf(s);
        if (item !== null && running(item.id))
          block(
            s,
            `Interactive item "${item.title}" has a running process using this session; stop the process first`,
          );
        if (s.variantBinding === 'run')
          block(s, 'A run session is kept with its run and cannot be deleted or archived');
        if ((action === 'archive' || action === 'unarchive') && s.engine === 'claude')
          block(s, 'Claude Code has no per-session archive; it can only be deleted');
        if ((action === 'archive' || action === 'unarchive') && s.hostId !== null)
          block(s, 'A session on an SSH host can only be deleted, not archived in the dashboard');
        if (action === 'archive' && s.archivedAt !== null) block(s, 'Already archived');
        if (action === 'unarchive' && s.archivedAt === null) block(s, 'Not archived');
        if (action === 'delete' && s.hostId !== null && hosts.brief(s.hostId) === null)
          block(s, 'Its SSH host has been deleted, so the remote original files cannot be deleted');
      }
    const sessionsOut: SessionActionPlan['sessions'] = [];
    for (const s of rows) {
      // Clearing leaves the files on disk untouched
      const local =
        action === 'clear' ? [] : s.engine === 'claude' ? claudeSessionFiles(s) : [s.filePath];
      sessionsOut.push({
        id: s.id,
        title: titles.get(s.id) ?? null,
        engine: s.engine,
        files: action === 'delete' ? [...local, ...(await remoteFilesOf(s))] : local,
      });
    }
    return {
      action,
      sessions: sessionsOut,
      liveItems: action === 'delete' ? rows.flatMap((s) => liveItemOf(s) ?? []) : [],
      blockers,
    };
  }

  // Files deleted remotely with a session on an SSH host, written as <label>:<path> (Contracts 31.6); empty when the host is deleted
  async function remoteFilesOf(s: SessionRow): Promise<string[]> {
    if (s.hostId === null || s.remotePath === null || hosts.brief(s.hostId) === null) return [];
    const host = hosts.known(s.hostId);
    const files =
      s.engine === 'claude' ? await remoteClaudeFiles(host, s.id, s.remotePath) : [s.remotePath];
    return files.map((f) => `${host.label}:${f}`);
  }

  // Run codex with this session's CODEX_HOME; on failure report the raw output (name is the title), dashboard records unchanged
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
        `${name}: codex ${args.join(' ')} failed (exit code ${String(result.exitCode)}):\n${result.all}`,
      );
    }
  }

  async function execute(action: SessionAction, ids: string[]): Promise<SessionActionPlan> {
    const p = await plan(action, ids);
    if (p.blockers.length > 0) {
      throw new HttpError(
        409,
        `Cannot ${actionLabel[action]}:\n${p.blockers.map((b) => `- ${b.label}`).join('\n')}`,
      );
    }
    const names = new Map(p.sessions.map((s) => [s.id, s.title ?? s.id]));
    for (const s of rowsOf(ids)) {
      const name = names.get(s.id) ?? s.id;
      if (action === 'clear') {
        // Only record the clear time: dashboard data and files on disk are kept; runs, analyses and Live items using it read as usual
        markCleared(db, s.id);
        console.info(`[sessions] Cleared ${s.engine} session ${s.id} (${s.filePath})`);
      } else if (action === 'delete') {
        // Session on an SSH host: first delete the remote original files (Codex ones via remote codex delete), then the local copy and records
        if (s.hostId !== null && s.remotePath !== null) {
          const host = hosts.known(s.hostId);
          if (s.engine === 'codex') await remoteCodexDelete(host, s.id);
          else await deleteRemoteFiles(host, await remoteClaudeFiles(host, s.id, s.remotePath));
        }
        // codex delete permanently deletes a Codex rollout; the dashboard deletes Claude Code files and records
        if (s.engine === 'codex' && s.hostId === null)
          await codex(['delete', '--force', s.id], s, name);
        if (s.liveId !== null) live.removeItem(s.liveId);
        if (s.engine === 'claude') deleteClaudeSessions(db, [s]);
        else {
          if (s.hostId !== null) fs.rmSync(s.filePath, { force: true });
          db.delete(sessions).where(eq(sessions.id, s.id)).run();
          forgetImports(db, [s.id]);
        }
        console.info(`[sessions] Deleted ${s.engine} session ${s.id} (${s.filePath})`);
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
  clear: 'clear',
  delete: 'delete',
  archive: 'archive',
  unarchive: 'restore',
};

export type SessionActions = ReturnType<typeof createSessionActions>;
