import { createHash } from 'node:crypto';
import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { z } from 'zod';
import { isDirectory } from '../dirs/exists.js';
import { readSessionMeta } from '../ingest/codex.js';
import { recordCwd } from '../ingest/session-import.js';
import type { RemoteHost } from '../remote/hosts.js';
import { sshScript } from '../remote/ssh.js';

// The session record of each Orca coordinator, worker and peer (Contracts 40.2), for the sessions that are not Live
// items yet (most workers that already ended). Orca keeps no session id for them, but its ids end up in the records:
// - a worker is told its own Dispatch and task in the text Orca types into it ("You are working inside Orca …
//   --dispatch-id ctx_…", "Your task ID is: task_…" in older Orcas), and its own terminal ("--from term_…");
// - the main agent gets the Run id back from run-create and each Dispatch id from worker-start before any other
//   session can mention them, and names its own terminal in the orchestration commands it runs (--from term_…);
// - a session that sends a cross-session message writes its body in its SendMessage call, which the receiver gets
//   verbatim; a subagent's message names the subagent, whose record sits under its parent session's.
// The Claude Code jsonl and Codex rollouts (sessions/ and archived_sessions/) are read once in full, then only what
// was appended since; only lines naming one of those are parsed. An SSH host's records are read the same way over ssh
// (server/remote-scripts/orca-records.sh)

export interface OrcaSessionRef {
  id: string;
  engine: 'claude' | 'codex';
  file: string;
}

// What one record file said so far
interface FileScan {
  mtimeMs: number;
  // Dispatches and tasks given to this session as its own task
  own: Set<string>;
  ownTasks: Set<string>;
  // When each Dispatch or Run id first appears in it
  seen: Map<string, number>;
  // The terminals it named as its own, when first and last
  handles: Map<string, { first: number; last: number }>;
  // Hashes of the cross-session messages it sent
  sent: Set<string>;
  // Null until a rollout's session_meta line is written
  session: OrcaSessionRef | null;
  // Its working directory as the record gives it; undefined until looked up
  cwd: string | null | undefined;
}

type Engine = OrcaSessionRef['engine'];

// A session's record can run to hundreds of megabytes: it is read in pieces of this size
const CHUNK = 8 * 1024 * 1024;
// The strings a line must hold to be parsed (an id prefix counts only before 8 hex digits, so run_in_background does
// not); remote-scripts/orca-records.sh greps for the same ones
const WORTH = /(?:ctx|run|task)_[0-9a-f]{8}|--from term_|"SendMessage"/;
const WANTED = new RegExp(WORTH.source, 'g');
const IDS = /\b(?:ctx|run)_[0-9a-f]{8,}\b/g;
const OWN_DISPATCH = /--dispatch-id (ctx_[0-9a-f]+)/g;
const OWN_TASK = /(?:Your task ID is: |--task-id )(task_[0-9a-f]+)/g;
const OWN_TERMINAL = /--from (term_[0-9a-f-]+)/g;
// The task Orca types into a worker it starts
const WORKER_TASK = 'You are working inside Orca';
// How soon after a Run or Dispatch is created the session that created it records its id, and how far the two clocks
// may disagree (Orca's times are whole seconds)
const STARTED_WITHIN = 10 * 60 * 1000;
const CLOCK_SKEW = 60 * 1000;

const Part = z.looseObject({
  type: z.string().optional(),
  text: z.unknown().optional(),
  name: z.string().optional(),
  input: z.unknown().optional(),
});
// A Claude Code record: user records carry what was typed (a string, or text parts beside tool results), assistant
// records the tool calls it made; a cross-session message is a user record whose origin is a peer
const ClaudeRecord = z.looseObject({
  type: z.string().optional(),
  timestamp: z.string().optional(),
  origin: z.looseObject({ kind: z.string() }).nullish(),
  message: z.looseObject({ content: z.unknown() }).optional(),
});
// A SendMessage call that only subscribes to a session's idle notice carries no message
const SendMessageInput = z.looseObject({ message: z.unknown().optional() });
// A Codex rollout record: a user message is a response_item message with role user, or an event_msg user_message; a
// command it ran is a response_item function_call, custom_tool_call or local_shell_call
const CodexRecord = z.looseObject({
  type: z.string(),
  timestamp: z.string().optional(),
  payload: z
    .looseObject({
      type: z.string().optional(),
      role: z.string().optional(),
      message: z.unknown().optional(),
      content: z.unknown().optional(),
      arguments: z.unknown().optional(),
      input: z.unknown().optional(),
      action: z.unknown().optional(),
    })
    .optional(),
});

const hashOf = (text: string) => createHash('sha256').update(text).digest('hex');

// The text of a message: itself when it is a string, else its parts that have text (of the given type only, when
// one is given: a Claude Code user record also holds tool results)
const textsOf = (content: unknown, type?: string): string[] => {
  if (typeof content === 'string') return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((part) => {
    const p = Part.parse(part);
    if (type !== undefined && p.type !== type) return [];
    return typeof p.text === 'string' ? [p.text] : [];
  });
};

interface Read {
  // What a user typed in this record (empty for tool output, peer messages and everything else)
  typed: string[];
  // The tool calls the agent made in it, as written
  ran: string[];
  // Bodies of the cross-session messages it sent
  sent: string[];
  at: number | null;
}

function readRecord(engine: Engine, raw: unknown): Read {
  const read: Read = { typed: [], ran: [], sent: [], at: null };
  if (engine === 'claude') {
    const r = ClaudeRecord.parse(raw);
    read.at = r.timestamp === undefined ? null : Date.parse(r.timestamp);
    if (r.message === undefined) return read;
    if (r.type === 'user' && r.origin?.kind !== 'peer') {
      read.typed = textsOf(r.message.content, 'text');
    }
    if (r.type === 'assistant' && Array.isArray(r.message.content)) {
      for (const part of r.message.content) {
        const p = Part.parse(part);
        if (p.type !== 'tool_use' || p.input === undefined) continue;
        read.ran.push(JSON.stringify(p.input));
        if (p.name !== 'SendMessage') continue;
        const body = SendMessageInput.parse(p.input).message;
        if (typeof body === 'string') read.sent.push(body);
      }
    }
    return read;
  }
  const r = CodexRecord.parse(raw);
  read.at = r.timestamp === undefined ? null : Date.parse(r.timestamp);
  const p = r.payload;
  if (p === undefined) return read;
  if (r.type === 'response_item' && p.type === 'message' && p.role === 'user') {
    read.typed = textsOf(p.content);
  } else if (r.type === 'event_msg' && p.type === 'user_message') {
    read.typed = textsOf(p.message);
  } else if (r.type === 'response_item') {
    const call =
      p.type === 'function_call'
        ? p.arguments
        : p.type === 'custom_tool_call'
          ? p.input
          : p.type === 'local_shell_call'
            ? JSON.stringify(p.action)
            : undefined;
    if (typeof call === 'string') read.ran.push(call);
  }
  return read;
}

function scanLine(engine: Engine, line: string, scan: FileScan): void {
  if (!WORTH.test(line)) return;
  const { typed, ran, sent, at } = readRecord(engine, JSON.parse(line));
  const told = typed.filter((text) => text.includes(WORKER_TASK));
  for (const text of told) {
    for (const m of text.matchAll(OWN_DISPATCH)) if (m[1] !== undefined) scan.own.add(m[1]);
    for (const m of text.matchAll(OWN_TASK)) if (m[1] !== undefined) scan.ownTasks.add(m[1]);
  }
  for (const body of sent) scan.sent.add(hashOf(body));
  if (at === null) return;
  for (const text of [...told, ...ran]) {
    for (const m of text.matchAll(OWN_TERMINAL)) {
      const handle = m[1];
      if (handle === undefined) continue;
      const known = scan.handles.get(handle);
      scan.handles.set(handle, {
        first: Math.min(known?.first ?? at, at),
        last: Math.max(known?.last ?? at, at),
      });
    }
  }
  for (const [id] of line.matchAll(IDS)) {
    const known = scan.seen.get(id);
    if (known === undefined || at < known) scan.seen.set(id, at);
  }
}

const newScan = (mtimeMs: number): FileScan => ({
  mtimeMs,
  own: new Set(),
  ownTasks: new Set(),
  seen: new Map(),
  handles: new Map(),
  sent: new Set(),
  session: null,
  cwd: undefined,
});

// The lines holding a needle in the complete lines of file from offset on; returns the offset after the last
// complete line
async function scanFrom(
  file: string,
  engine: Engine,
  size: number,
  offset: number,
  scan: FileScan,
): Promise<number> {
  const handle = await open(file, 'r');
  let carry = Buffer.alloc(0);
  let at = offset;
  let done = offset;
  while (at < size) {
    const piece = Buffer.alloc(Math.min(CHUNK, size - at));
    const { bytesRead } = await handle.read(piece, 0, piece.length, at);
    if (bytesRead === 0) break;
    at += bytesRead;
    const data = Buffer.concat([carry, piece.subarray(0, bytesRead)]);
    const end = data.lastIndexOf(0x0a);
    if (end === -1) {
      carry = data;
      continue;
    }
    // Every line holding a needle, once: found in the bytes read as latin1, so a character's index is its byte offset
    const text = data.toString('latin1', 0, end);
    WANTED.lastIndex = 0;
    for (let m = WANTED.exec(text); m !== null; m = WANTED.exec(text)) {
      const start = text.lastIndexOf('\n', m.index) + 1;
      const stop = text.indexOf('\n', m.index);
      const lineEnd = stop === -1 ? end : stop;
      scanLine(engine, data.toString('utf8', start, lineEnd), scan);
      WANTED.lastIndex = lineEnd + 1;
    }
    // done is where carry starts, so it moves past every byte of the lines just read
    done += end + 1;
    carry = data.subarray(end + 1);
  }
  await handle.close();
  return done;
}

// What is asked of the records, the same for this machine and an SSH host
function finder(
  scans: () => Iterable<FileScan>,
  parents: Map<string, string>,
  cwdOf: (scan: FileScan) => string | null,
) {
  const all = () => [...scans()];
  const sessionsOf = (list: FileScan[]) =>
    list.flatMap((scan) => (scan.session === null ? [] : [scan.session]));
  const newestFirst = (list: FileScan[]) => sessionsOf(list.sort((a, b) => b.mtimeMs - a.mtimeMs));
  const scanOf = (sessionId: string) => all().find((scan) => scan.session?.id === sessionId);
  return {
    // The sessions given this Dispatch as their own task, else this task (older Orcas named only the task), the one
    // written last first (a forked copy holds it too)
    workers(dispatchId: string, taskId: string): OrcaSessionRef[] {
      const byDispatch = all().filter((scan) => scan.own.has(dispatchId));
      if (byDispatch.length > 0) return newestFirst(byDispatch);
      return newestFirst(all().filter((scan) => scan.ownTasks.has(taskId)));
    },

    // The main agent's sessions of a Run: for the Run and each of its Dispatches, the session other than the Run's
    // own workers that named its id first, within minutes of its creation (the main agent gets the id back from
    // run-create and worker-start; a session reading about it later is not the one that made it). A main agent can
    // go through several sessions (it cleared its context); the one that made most of them comes first (on a tie,
    // the earliest)
    coordinators(
      run: { id: string; at: number },
      workers: { dispatchId: string; taskId: string; at: number | null }[],
    ): OrcaSessionRef[] {
      const dispatches = new Set(workers.map((w) => w.dispatchId));
      const tasks = new Set(workers.map((w) => w.taskId));
      // A session that took one of these Dispatches or tasks as its own is a worker of this Run
      const others = all().filter(
        (scan) =>
          scan.session !== null &&
          ![...scan.own].some((d) => dispatches.has(d)) &&
          ![...scan.ownTasks].some((t) => tasks.has(t)),
      );
      const votes = new Map<FileScan, { n: number; first: number }>();
      const made = [run, ...workers.map((w) => ({ id: w.dispatchId, at: w.at }))];
      for (const { id, at: created } of made) {
        if (created === null) continue;
        let first: { scan: FileScan; at: number } | null = null;
        for (const scan of others) {
          const at = scan.seen.get(id);
          if (at === undefined || at < created - CLOCK_SKEW || at > created + STARTED_WITHIN) {
            continue;
          }
          if (first === null || at < first.at) first = { scan, at };
        }
        if (first === null) continue;
        const known = votes.get(first.scan) ?? { n: 0, first: first.at };
        known.n += 1;
        known.first = Math.min(known.first, first.at);
        votes.set(first.scan, known);
      }
      return sessionsOf(
        [...votes].sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first).map(([s]) => s),
      );
    },

    // The sessions that named this terminal as their own, the one doing so nearest to at first (a terminal Orca
    // keeps can run one session after another)
    inTerminal(handle: string, at: number | null): OrcaSessionRef[] {
      const distance = (scan: FileScan) => {
        const span = scan.handles.get(handle);
        if (span === undefined) return Infinity;
        if (at === null) return -span.last;
        return at < span.first ? span.first - at : at > span.last ? at - span.last : 0;
      };
      return sessionsOf(
        all()
          .filter((scan) => scan.handles.has(handle))
          .sort((a, b) => distance(a) - distance(b)),
      );
    },

    // The sessions that sent a cross-session message with this body, the one written last first
    senderOf(body: string): OrcaSessionRef[] {
      const hash = hashOf(body);
      return newestFirst(all().filter((scan) => scan.sent.has(hash)));
    },

    // The session a subagent ran in
    parentOf(agentId: string): OrcaSessionRef | null {
      const parent = parents.get(agentId);
      return parent === undefined ? null : (scanOf(parent)?.session ?? null);
    },

    // The working directory its record gives
    cwdOf(session: OrcaSessionRef): string | null {
      const scan = scanOf(session.id);
      return scan === undefined ? null : cwdOf(scan);
    },

    // The record file of a session found here
    fileOf(sessionId: string): OrcaSessionRef | null {
      return scanOf(sessionId)?.session ?? null;
    },
  };
}

// Main record files only: a Claude Code project's <session id>.jsonl and Codex's rollout-*.jsonl; a subagent's
// record (<project>/<session id>/subagents/agent-<agent id>.jsonl) only names its parent
async function recordFiles(
  root: string,
  engine: Engine,
): Promise<{ files: { file: string; engine: Engine }[]; parents: [string, string][] }> {
  const entries = (await isDirectory(root))
    ? await readdir(root, { recursive: true, withFileTypes: true })
    : [];
  const jsonl = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl'));
  if (engine === 'codex') {
    return {
      files: jsonl
        .filter((e) => e.name.startsWith('rollout-'))
        .map((e) => ({ file: path.join(e.parentPath, e.name), engine })),
      parents: [],
    };
  }
  return {
    files: jsonl
      .filter((e) => path.dirname(e.parentPath) === root)
      .map((e) => ({ file: path.join(e.parentPath, e.name), engine })),
    parents: jsonl
      .filter((e) => path.basename(e.parentPath) === 'subagents' && e.name.startsWith('agent-'))
      .map((e) => [
        path.basename(e.name, '.jsonl').slice('agent-'.length),
        path.basename(path.dirname(e.parentPath)),
      ]),
  };
}

export function createOrcaSessions(deps: { localHome: string }) {
  const roots = [
    { dir: path.join(deps.localHome, '.claude', 'projects'), engine: 'claude' as const },
    { dir: path.join(deps.localHome, '.codex', 'sessions'), engine: 'codex' as const },
    { dir: path.join(deps.localHome, '.codex', 'archived_sessions'), engine: 'codex' as const },
  ];
  const scans = new Map<string, FileScan & { offset: number }>();
  const parents = new Map<string, string>();

  const sessionOf = (file: string, engine: Engine): OrcaSessionRef | null => {
    if (engine === 'claude') return { id: path.basename(file, '.jsonl'), engine, file };
    const meta = readSessionMeta(file);
    return meta === null ? null : { id: meta.id, engine, file };
  };

  return {
    // Where the records are looked for
    dirs: roots.map((r) => r.dir),

    // Read what was appended to every record file since the last time (all of each file the first time)
    async refresh(): Promise<void> {
      const listed = await Promise.all(roots.map((r) => recordFiles(r.dir, r.engine)));
      parents.clear();
      for (const { parents: found } of listed) for (const [a, p] of found) parents.set(a, p);
      const present = new Set<string>();
      for (const { file, engine } of listed.flatMap((l) => l.files)) {
        present.add(file);
        const info = await stat(file);
        let scan = scans.get(file);
        // A record that shrank was rewritten: read it again from the start
        if (scan === undefined || info.size < scan.offset) {
          scan = { ...newScan(info.mtimeMs), offset: 0 };
          scans.set(file, scan);
        }
        scan.mtimeMs = info.mtimeMs;
        scan.session ??= sessionOf(file, engine);
        if (info.size > scan.offset) {
          scan.offset = await scanFrom(file, engine, info.size, scan.offset, scan);
        }
      }
      for (const file of scans.keys()) if (!present.has(file)) scans.delete(file);
    },

    ...finder(
      () => scans.values(),
      parents,
      (scan) => {
        if (scan.cwd === undefined && scan.session !== null) {
          scan.cwd = recordCwd(scan.session.engine, scan.session.file);
        }
        return scan.cwd ?? null;
      },
    ),
  };
}

export type OrcaSessions = ReturnType<typeof createOrcaSessions>;

const RemoteFile = /^@@file (claude|codex) (\d+) (\d+) (\d+) (.+)$/;
const RemoteAgent = /^@@agent (\S+) (\S+)$/;
const RemoteMeta = z.object({ cwd: z.string().optional(), id: z.string().optional() });

type RemoteScan = FileScan & { size: number; lines: number };

// The same for an SSH host's records, read over ssh: each sync sends the size and line count of every file read
// before, and the host returns, for each file that changed, the lines it gained that hold a needle
export function createRemoteOrcaSessions(host: RemoteHost) {
  const scans = new Map<string, RemoteScan>();
  const parents = new Map<string, string>();

  return {
    async refresh(): Promise<void> {
      const known = [...scans]
        .map(([file, s]) => `${String(s.size)} ${String(s.lines)} ${file}`)
        .join('\n');
      const sent = await sshScript(host.target, 'orca-records.sh', [host.home, known]);
      const out = gunzipSync(Buffer.from(sent, 'base64')).toString('utf8');
      parents.clear();
      const present = new Set<string>();
      let current: { file: string; engine: Engine; scan: RemoteScan } | null = null;
      for (const line of out.split('\n')) {
        const listed = RemoteFile.exec(line);
        if (listed !== null) {
          const [, kind, size, lines, mtime, file] = listed;
          if (kind === undefined || size === undefined || lines === undefined) continue;
          if (mtime === undefined || file === undefined) continue;
          const engine: Engine = kind === 'codex' ? 'codex' : 'claude';
          present.add(file);
          let scan = scans.get(file);
          // Read from its first line again (new, or rewritten)
          if (scan === undefined || Number(size) < scan.size) {
            scan = { ...newScan(0), size: 0, lines: 0 };
            if (engine === 'claude') {
              scan.session = { id: path.posix.basename(file, '.jsonl'), engine, file };
            }
            scans.set(file, scan);
          }
          scan.mtimeMs = Number(mtime) * 1000;
          scan.size = Number(size);
          scan.lines = Number(lines);
          current = { file, engine, scan };
          continue;
        }
        const agent = RemoteAgent.exec(line);
        if (agent?.[1] !== undefined && agent[2] !== undefined) {
          parents.set(agent[1], agent[2]);
          continue;
        }
        if (current === null || line === '') continue;
        if (line.startsWith('@@meta ')) {
          const meta = RemoteMeta.parse(JSON.parse(line.slice('@@meta '.length)));
          current.scan.cwd = meta.cwd ?? null;
          if (current.engine === 'codex' && meta.id !== undefined) {
            current.scan.session = { id: meta.id, engine: 'codex', file: current.file };
          }
          continue;
        }
        scanLine(current.engine, line, current.scan);
      }
      for (const file of scans.keys()) if (!present.has(file)) scans.delete(file);
    },

    ...finder(
      () => scans.values(),
      parents,
      (scan) => scan.cwd ?? null,
    ),
  };
}

export type RemoteOrcaSessions = ReturnType<typeof createRemoteOrcaSessions>;
