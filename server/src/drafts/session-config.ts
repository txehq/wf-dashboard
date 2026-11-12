import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { type LiveEngine, type LivePurpose, liveProcesses, liveSessions } from '../db/schema.js';
import { events } from '../events.js';
import { type DraftLayout, draftLayout, sessionSkillsDir } from './dir.js';

// Working dir of design and optimize sessions: an optimize session's src/ is under optimize/ (Contracts 19.3)
export const sessionLayoutOf = (item: { cwd: string; purpose: LivePurpose }) =>
  draftLayout(item.cwd, item.purpose === 'optimize' ? 'optimize' : 'workflow');

// src/skills is installed into the session's own config (Contracts 28.2): claude-config/skills/ (user scope) for Claude Code,
// the working dir's .agents/skills/ for Codex, next to the three tool skills
export const sessionSrcSkillsDir = (layout: DraftLayout, engine: LiveEngine) =>
  engine === 'codex' ? layout.agentSkills : path.join(layout.claudeDir, 'skills');

// Records in the working dir which skills were installed from src/skills: only those are deleted or overwritten
const SYNCED_FILE = '.session-src-skills.json';

const dirNames = (dir: string) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name)
        .sort()
    : [];

// Both dirs have the same files, symlinks and contents
function sameTree(a: string, b: string): boolean {
  if (!fs.existsSync(b)) return false;
  const entries = (dir: string) =>
    fs
      .readdirSync(dir, { recursive: true, withFileTypes: true })
      .map((e) => ({ rel: path.relative(dir, path.join(e.parentPath, e.name)), entry: e }))
      .sort((x, y) => x.rel.localeCompare(y.rel));
  const left = entries(a);
  const right = entries(b);
  if (left.length !== right.length) return false;
  return left.every(({ rel, entry }, i) => {
    const other = right[i];
    if (other?.rel !== rel) return false;
    if (entry.isSymbolicLink()) {
      return (
        other.entry.isSymbolicLink() &&
        fs.readlinkSync(path.join(a, rel)) === fs.readlinkSync(path.join(b, rel))
      );
    }
    if (entry.isDirectory()) return other.entry.isDirectory();
    return (
      other.entry.isFile() &&
      fs.readFileSync(path.join(a, rel)).equals(fs.readFileSync(path.join(b, rel)))
    );
  });
}

// Make the src skills in the session config match src/skills: added and changed dirs are copied again whole, ones deleted from src/skills are removed.
// Skills put in by the chosen variant and ones the agent installed with find-skills are not from src/skills;
// same-named src skills are not installed and those are not deleted. Returns the installed src skills
export function syncSessionSkills(layout: DraftLayout, engine: LiveEngine): string[] {
  const target = sessionSrcSkillsDir(layout, engine);
  fs.mkdirSync(target, { recursive: true });
  const manifest = path.join(layout.dir, SYNCED_FILE);
  const previous = fs.existsSync(manifest)
    ? z.array(z.string()).parse(JSON.parse(fs.readFileSync(manifest, 'utf8')))
    : [];
  const own = new Set(previous);
  const reserved = new Set(
    [...dirNames(target), ...dirNames(sessionSkillsDir(layout, engine))].filter(
      (name) => !own.has(name),
    ),
  );
  const names = dirNames(layout.skills).filter((name) => !reserved.has(name));
  for (const name of previous) {
    if (!names.includes(name)) fs.rmSync(path.join(target, name), { recursive: true, force: true });
  }
  for (const name of names) {
    const from = path.join(layout.skills, name);
    const to = path.join(target, name);
    if (sameTree(from, to)) continue;
    fs.rmSync(to, { recursive: true, force: true });
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true });
  }
  const tmp = `${manifest}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(names)}\n`);
  fs.renameSync(tmp, manifest);
  return names;
}

// Interval for comparing src/skills, the same as the workflow panel's watching (Contracts 26.4)
const POLL_MS = 250;

// mtime, size and inode of each entry (file, dir, symlink) under src/skills
function signatureOf(dir: string): string {
  if (!fs.existsSync(dir)) return '';
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .map((e) => {
      const file = path.join(e.parentPath, e.name);
      const stat = fs.lstatSync(file, { throwIfNoEntry: false });
      return stat === undefined
        ? ''
        : `${path.relative(dir, file)}:${String(stat.mtimeMs)}:${String(stat.size)}:${String(stat.ino)}`;
    })
    .sort()
    .join('\n');
}

interface Poller {
  signature: string;
  timer: ReturnType<typeof setInterval>;
}

// Install-as-you-write while a design or optimize session's process runs (Contracts 28.2): compare src/skills every 250 ms and sync changes into the session config.
// Live syncs once before start and resume; this covers only the running process, and stops when the process ends or the item is closed or deleted
export function createSessionSync({ db }: { db: Db }) {
  const pollers = new Map<string, Poller>();

  function stop(liveId: string) {
    const poller = pollers.get(liveId);
    if (poller === undefined) return;
    clearInterval(poller.timer);
    pollers.delete(liveId);
  }

  function update(liveId: string) {
    const item = db
      .select({
        cwd: liveSessions.cwd,
        purpose: liveSessions.purpose,
        engine: liveSessions.engine,
        hiddenAt: liveSessions.hiddenAt,
      })
      .from(liveSessions)
      .where(eq(liveSessions.id, liveId))
      .get();
    const running =
      item?.hiddenAt === null &&
      (item.purpose === 'design' || item.purpose === 'optimize') &&
      db
        .select({ id: liveProcesses.id })
        .from(liveProcesses)
        .where(and(eq(liveProcesses.liveId, liveId), eq(liveProcesses.status, 'running')))
        .get() !== undefined;
    if (!running) {
      stop(liveId);
      return;
    }
    if (pollers.has(liveId)) return;
    const layout = sessionLayoutOf(item);
    const poller: Poller = {
      // Sync once at the first comparison: changes since Live's pre-start sync (not synced inside the event publish, so an error does not affect starting)
      signature: '',
      // Must not throw from the timer (an uncaught exception would exit the whole server): on error log the original text and stop; Live syncs again
      // before the next start or resume (throwing there on error)
      timer: setInterval(() => {
        try {
          const next = signatureOf(layout.skills);
          if (next === poller.signature) return;
          poller.signature = next;
          syncSessionSkills(layout, item.engine);
        } catch (error) {
          console.error(
            `[session-skills] Syncing src/skills of Live item ${liveId} failed; install-as-you-write stopped: ${error instanceof Error ? error.message : String(error)}`,
          );
          stop(liveId);
        }
      }, POLL_MS),
    };
    pollers.set(liveId, poller);
  }

  const unsubscribe = events.subscribe((event) => {
    if (event.type === 'live.updated') update(event.liveId);
  });

  return {
    // Items currently installing as they are written
    active: () => [...pollers.keys()],
    shutdown() {
      unsubscribe();
      for (const liveId of [...pollers.keys()]) stop(liveId);
    },
  };
}

export type SessionSync = ReturnType<typeof createSessionSync>;
