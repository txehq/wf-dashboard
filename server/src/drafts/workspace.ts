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

// Interval for comparing the working dir: polled like the ingest watcher, independent of FSEvents (which drops whole runs of events under heavy writes)
const POLL_MS = 250;
// Previous-version snapshot: compared every second, recorded once file changes have been still for 5 seconds (Contracts 26.4)
const SNAPSHOT_POLL_MS = 1000;
export const SNAPSHOT_QUIET_MS = 5000;

// An item's latest src/skills change: signature, time of change, and whether a snapshot was considered since
interface Quiet {
  sig: string;
  changedAt: number;
  recorded: boolean;
}

const atOf = (found: { at: number } | null) => (found === null ? null : { at: found.at });

// One SSE connection
export interface WorkspaceConnection {
  send(event: WorkspaceEvent): void;
  // The server ends this connection
  end(): void;
}

interface Watcher {
  src: string;
  workflowYaml: string;
  // mtime, size and inode of files (relative to src/) and workflow.yaml
  snapshot: Map<string, string>;
  connections: Set<WorkspaceConnection>;
  timer: ReturnType<typeof setInterval>;
}

const WORKFLOW_KEY = 'workflow.yaml';

// Files under src/skills (relative to src/); empty while preparing before src is copied. Symlinks are not files and are not listed
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

// A workflow.yaml parse failure is a result shown to people (Contracts 26.2), returned with the original text
function readWorkflow(file: string): { definition: WorkflowDefinition } | { error: string } {
  if (!fs.existsSync(file)) return { error: `No workflow.yaml: ${file}` };
  const doc = parseDocument(fs.readFileSync(file, 'utf8'));
  if (doc.errors.length > 0) {
    return {
      error: `workflow.yaml is not valid YAML: ${doc.errors.map((e) => e.message).join('; ')}`,
    };
  }
  const result = WorkflowDefinition.safeParse(doc.toJS());
  if (!result.success) {
    return { error: `workflow.yaml does not match the workflow schema: ${result.error.message}` };
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

// Workflow panel of design and optimize sessions (Contracts 26.4): read-only view and watching of src/skills and workflow.yaml in the working dir
export function createWorkspace({ db, drafts }: { db: Db; drafts: Drafts }) {
  const watchers = new Map<string, Watcher>();

  function tree(liveId: string): WorkspaceView {
    const { draft, layout, base, baseSrc } = drafts.workspaceOf(liveId);
    const paths = [...new Set([...filesOf(layout.src), ...filesOf(baseSrc)])].sort();
    // Files the agent deletes between listing and reading are no longer listed
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

  // Root of what is compared against (with skills/ under it): the base's src/ for base (null when none, everything new); 409 when last saved or previous does not exist
  function againstRoot(liveId: string, against: WorkspaceAgainst): string | null {
    const { draft, layout, baseSrc } = drafts.workspaceOf(liveId);
    if (against === 'base') return baseSrc;
    if (against === 'saved') {
      const saved = savedCopy(layout);
      if (saved === null) throw new HttpError(409, `Draft ${draft.id} has never been saved`);
      return saved.root;
    }
    const previous = previousSnapshot(layout);
    if (previous === null) {
      throw new HttpError(
        409,
        'No previous version yet: one is recorded once file changes have been still for 5 seconds',
      );
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

  // The item was closed or deleted (both publish live.updated): notify the page and release the watcher
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

  // Previous-version snapshots (Contracts 26.4, 28.4): for open, prepared design and optimize items, compare mtime and size of files under src/skills every second,
  // recording a copy once the last change has been still for 5 seconds (not when equal to the latest). Separate from the SSE watcher, so it records with no page open;
  // items first seen after server start count from then
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
    // The agent deleting a dir mid-listing or mid-copy (ENOENT) is a normal change: the item's signature changes and it is recorded again after 5 still seconds.
    // Other errors are thrown as usual
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

    // A page starts watching this item; returns the function to call on disconnect (repeated calls count once). Connections to the same item share one watcher,
    // released when the last disconnects. Items without a draft are 404 (thrown before SSE starts)
    watch(liveId: string, connection: WorkspaceConnection): () => void {
      let watcher = watchers.get(liveId);
      if (watcher === undefined) {
        const { layout } = drafts.workspaceOf(liveId);
        // Closed items are no longer watched (EventSource gets this error when it reconnects after closed, and stops retrying)
        const item = db
          .select({ hiddenAt: liveSessions.hiddenAt })
          .from(liveSessions)
          .where(eq(liveSessions.id, liveId))
          .get();
        if (item?.hiddenAt !== null) throw new HttpError(409, `Live item ${liveId} is closed`);
        const created: Watcher = {
          src: layout.src,
          workflowYaml: layout.workflowYaml,
          snapshot: snapshotOf(layout.src, layout.workflowYaml),
          connections: new Set(),
          // Must not throw from the timer (an uncaught exception would exit the whole server): on error send the original text to the page and release
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
