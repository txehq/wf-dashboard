import fs from 'node:fs';
import path from 'node:path';
import { stringify } from '@decimalturn/toml-patch';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import {
  type LiveDriver,
  liveEvents,
  type LiveEventKind,
  liveProcesses,
  liveSessions,
} from '../db/schema.js';
import { events } from '../events.js';
import { ingestCodexFile } from '../ingest/codex.js';
import { sessionConversation } from '../ingest/conversation.js';
import { type SessionWatcher, watchSession } from '../ingest/watch.js';
import type { SettingsStore } from '../runs/settings.js';
import type { SimulatedGoal, SimulatedPersona, TranscriptEntry } from '../runs/simulated-user.js';
import type { RemoteSessionSync } from '../remote/sync.js';
import { HttpError } from '../variants/errors.js';
import type { LivePty, LiveTerminal } from './pty.js';
import { type HandBackReason, SimulatedDriver } from './simulated-driver.js';
import type { LiveWaiting } from './views.js';

// Codex sessions (Contracts 17.3, measured with codex-cli 0.162.0, Reports/W42): cwd is the draft directory, CODEX_HOME and
// HOME are the draft's own directories; the sandbox is Codex's own workspace-write (writes only to cwd) plus network

export function codexDirsOf(cwd: string) {
  return { codexHome: path.join(cwd, 'codex-home'), home: path.join(cwd, 'home') };
}

const SANDBOX_ARGS = [
  '--no-daemon',
  '-s',
  'workspace-write',
  '-c',
  'sandbox_workspace_write.network_access=true',
];

export const codexStartArgs = (prompt: string) => [...SANDBOX_ARGS, prompt];
export const codexResumeArgs = (sessionId: string) => ['resume', ...SANDBOX_ARGS, sessionId];

// Magi Agent's Codex (Contracts 23.3, measured with codex-cli 0.162.0, Reports/W60): the user's own ~/.codex, no sandbox;
// worktree trust only works as a whole projects table (projects."<path>".trust_level has no effect), config.toml untouched;
// MAGI.md is passed as developer_instructions; no update check on startup (the user's config checks by default and would
// run npm install -g in the terminal). With a null message there is no initial message; the user types the first one
function agentArgs(cwd: string, instructions: string): string[] {
  return [
    '--no-daemon',
    '--dangerously-bypass-approvals-and-sandbox',
    '-c',
    'check_for_update_on_startup=false',
    '-c',
    stringify({ projects: { [cwd]: { trust_level: 'trusted' } } }, { inlineTableStart: 0 }).trim(),
    '-c',
    stringify({ developer_instructions: instructions }).trim(),
  ];
}

export function codexAgentStartArgs(cwd: string, instructions: string, message: string | null) {
  return [...agentArgs(cwd, instructions), ...(message === null ? [] : [message])];
}

export function codexAgentResumeArgs(
  cwd: string,
  instructions: string,
  sessionId: string,
  message: string | null,
) {
  return [
    'resume',
    ...agentArgs(cwd, instructions),
    sessionId,
    ...(message === null ? [] : [message]),
  ];
}

// Codex on an SSH host (Contracts 31.3): the remote machine's own ~/.codex, sandbox and approvals per its config; the working
// path is marked trusted (as for Magi Agent, only as a whole projects table), no update check on startup
export function codexRemoteArgs(cwd: string): string[] {
  return [
    '--no-daemon',
    '-c',
    'check_for_update_on_startup=false',
    '-c',
    stringify({ projects: { [cwd]: { trust_level: 'trusted' } } }, { inlineTableStart: 0 }).trim(),
  ];
}

export function codexRemoteResumeArgs(cwd: string, sessionId: string): string[] {
  return ['resume', ...codexRemoteArgs(cwd), sessionId];
}

// Extra keys writeCodexHome writes: the draft directory is trusted (-c overrides have no effect, only config.toml), no update
// check, Codex's bundled skills such as its own skill-creator are disabled (only those installed in .agents/skills/ are used)
export function codexConfigExtra(cwd: string): Record<string, unknown> {
  return {
    check_for_update_on_startup: false,
    projects: { [cwd]: { trust_level: 'trusted' } },
    skills: { bundled: { enabled: false } },
  };
}

// First line of a rollout file
const SessionMeta = z.looseObject({
  type: z.literal('session_meta'),
  payload: z.looseObject({ id: z.string().min(1), cwd: z.string() }),
});

// All rollout files under CODEX_HOME/sessions
export function rolloutFiles(codexHome: string): string[] {
  const dir = path.join(codexHome, 'sessions');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile() && e.name.startsWith('rollout-') && e.name.endsWith('.jsonl'))
    .map((e) => path.join(e.parentPath, e.name));
}

// Session id of a rollout not in known whose cwd is this directory; null before its first line is written
export function newSessionId(codexHome: string, cwd: string, known: Set<string>): string | null {
  const real = fs.realpathSync(cwd);
  for (const file of rolloutFiles(codexHome)) {
    if (known.has(file)) continue;
    const first = fs.readFileSync(file, 'utf8').split('\n')[0] ?? '';
    if (first.trim() === '') continue;
    const meta = SessionMeta.parse(JSON.parse(first));
    // The user's own ~/.codex has sessions from elsewhere whose cwd may no longer exist
    if (fs.existsSync(meta.payload.cwd) && fs.realpathSync(meta.payload.cwd) === real) {
      return meta.payload.id;
    }
  }
  return null;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// A submitted user message in a rollout (measured with codex-cli 0.162.1): event_msg item_completed with a UserMessage item
const UserMessageRecord = z.looseObject({
  type: z.literal('event_msg'),
  payload: z.looseObject({
    type: z.literal('item_completed'),
    item: z.looseObject({
      type: z.literal('UserMessage'),
      content: z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
    }),
  }),
});

// The first user message in this session's rollout; null when there is none yet or the rollout is not written
export function firstUserMessage(codexHome: string, sessionId: string): string | null {
  const file = rolloutFiles(codexHome).find((f) => f.endsWith(`-${sessionId}.jsonl`));
  if (file === undefined) return null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const record = UserMessageRecord.safeParse(JSON.parse(line));
    if (!record.success) continue;
    const text = record.data.payload.item.content
      .flatMap((c) => (c.type === 'text' && c.text !== undefined ? [c.text] : []))
      .join('\n');
    if (text.trim() !== '') return text;
  }
  return null;
}

// Codex's "turn ended" signal (Contracts 34.2, measured with codex-cli 0.163.0, Reports/W103): event_msg task_complete in the
// rollout, last_agent_message is the turn's final answer; a "just answer ok" turn is written after 4.9 s
const TaskComplete = z.looseObject({
  type: z.literal('task_complete'),
  turn_id: z.string().optional(),
  last_agent_message: z.string().nullable().optional(),
});

export interface CodexTurn {
  turnId: string | null;
  text: string;
}

// Incrementally reads new turn-end records from a rollout: only content after the last read, a half-written last line waits
export class RolloutTurns {
  private offset = 0;
  private partial = '';

  constructor(private readonly file: string) {}

  next(): CodexTurn[] {
    if (!fs.existsSync(this.file)) return [];
    const size = fs.statSync(this.file).size;
    if (size < this.offset) {
      // File was overwritten (remote copy re-synced): read from the start
      this.offset = 0;
      this.partial = '';
    }
    if (size === this.offset) return [];
    const buffer = Buffer.alloc(size - this.offset);
    const fd = fs.openSync(this.file, 'r');
    fs.readSync(fd, buffer, 0, buffer.length, this.offset);
    fs.closeSync(fd);
    this.offset = size;
    const text = this.partial + buffer.toString('utf8');
    const lines = text.split('\n');
    this.partial = lines.pop() ?? '';
    const turns: CodexTurn[] = [];
    for (const line of lines) {
      if (line.trim() === '') continue;
      const record = z
        .looseObject({ type: z.string(), payload: z.unknown() })
        .safeParse(JSON.parse(line));
      if (!record.success || record.data.type !== 'event_msg') continue;
      const complete = TaskComplete.safeParse(record.data.payload);
      if (!complete.success) continue;
      turns.push({
        turnId: complete.data.turn_id ?? null,
        text: complete.data.last_agent_message ?? '',
      });
    }
    return turns;
  }
}

// Codex writes the rollout only after the initial message is submitted: wait for it. On early exit or timeout, stop the process and report the screen
export async function waitForSession(
  pty: LivePty,
  codexHome: string,
  cwd: string,
  known: Set<string>,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (pty.alive && Date.now() < deadline) {
    const id = newSessionId(codexHome, cwd, known);
    if (id !== null) return id;
    await sleep(200);
  }
  const screen = (await pty.viewport()).filter((l) => l.trim() !== '').join('\n');
  const exitedEarly = !pty.alive;
  pty.kill('SIGHUP');
  await pty.exited;
  throw new HttpError(
    500,
    `Codex wrote no session record within ${String(timeoutMs / 1000)} s (${path.join(codexHome, 'sessions')})${exitedEarly ? ', the process has exited' : ''}; screen:\n${screen}`,
  );
}

// Poll interval for turn-end records (same as incremental import)
const TURN_POLL_MS = 250;

export interface CodexRunnerOptions {
  db: Db;
  settings: SettingsStore;
  liveId: string;
  processId: number;
  pty: LiveTerminal;
  // Rollout to import incrementally and read turn ends from (the local copy when remote); null until the session id is known, then given by follow
  tail?: string | null;
  // Codex on an SSH host (Contracts 31.6): the remote rollout syncs to a local copy (tail), synced once more on exit
  remote?: RemoteSessionSync | null;
  // The goal handed to the simulated user for this item, or the persona it plays (Contracts 34.2); read before each answer
  role: () => SimulatedPersona | SimulatedGoal;
  // Driver at startup
  initialDriver: LiveDriver;
}

// A running Codex process: at each turn end (task_complete in the rollout) the simulated user drives or a human is awaited (Contracts 34.2).
// tail is the rollout to import: every 250 ms like Claude Code, read to the end on exit; import errors go to this process's error
export class CodexRunner {
  readonly engine = 'codex';
  readonly starting = false;
  readonly liveId: string;
  readonly processId: number;
  readonly pty: LiveTerminal;
  watching: boolean;
  readonly exited: Promise<void>;
  private readonly db: Db;
  private readonly remote: RemoteSessionSync | null;
  private readonly simulated: SimulatedDriver;
  private watcher: SessionWatcher | null = null;
  private tail: string | null = null;
  private turns: RolloutTurns | null = null;
  private readonly turnTimer: NodeJS.Timeout;

  constructor(opts: CodexRunnerOptions) {
    this.db = opts.db;
    this.liveId = opts.liveId;
    this.processId = opts.processId;
    this.pty = opts.pty;
    this.remote = opts.remote ?? null;
    this.watching = false;
    this.simulated = new SimulatedDriver({
      db: opts.db,
      settings: opts.settings,
      liveId: opts.liveId,
      processId: opts.processId,
      pty: opts.pty,
      role: opts.role,
      eval: null,
      transcript: (waiting) => this.transcript(waiting),
      starting: () => false,
      answerQuestions: () => {
        throw new Error('Codex has no AskUserQuestion');
      },
      onError: (error) => {
        this.recordError(error);
      },
      event: (kind, payload) => {
        this.event(kind, payload);
      },
    });
    const tail = opts.tail ?? null;
    if (tail !== null) this.follow(tail);
    // Turn end: a newly written task_complete in the rollout (Contracts 34.2)
    this.turnTimer = setInterval(() => {
      this.readTurns();
    }, TURN_POLL_MS);
    if (opts.initialDriver === 'simulated') this.simulated.setDriver('simulated', 'start');
    const stopConnection = this.pty.onConnection((connected) => {
      if (this.pty.alive) this.event(connected ? 'reconnect' : 'disconnect', {});
      // The simulated user does not drive while disconnected (Contracts 31.4)
      if (!connected && this.pty.alive && this.driver === 'simulated') {
        this.simulated.setDriver('human', 'disconnected');
      }
      if (connected) void this.remote?.syncNow();
    });
    this.exited = this.pty.exited.then(async (exit) => {
      stopConnection();
      clearInterval(this.turnTimer);
      this.simulated.abort(new Error('Process exited'));
      await this.remote?.close(true);
      await this.watcher?.close();
      this.watching = false;
      const tail = this.tail;
      if (tail !== null && fs.existsSync(tail)) ingestCodexFile(this.db, tail);
      this.remote?.mark();
      const endedAt = new Date();
      this.db
        .update(liveProcesses)
        .set({
          status: 'exited',
          exitCode: exit.exitCode,
          endedAt,
          ...(exit.error === null ? {} : { error: exit.error }),
        })
        .where(eq(liveProcesses.id, this.processId))
        .run();
      this.db
        .update(liveSessions)
        .set({ updatedAt: endedAt })
        .where(eq(liveSessions.id, this.liveId))
        .run();
      this.event('exit', { exitCode: exit.exitCode, signal: exit.signal, error: exit.error });
    });
  }

  get waiting(): LiveWaiting | null {
    return this.simulated.waiting;
  }

  get driver(): LiveDriver {
    return this.simulated.driver;
  }

  setDriver(driver: LiveDriver, reason: HandBackReason | 'start' | 'release') {
    this.simulated.setDriver(driver, reason);
  }

  // "Hand over": the driver becomes the simulated user; answers at once if Codex is waiting for input
  release() {
    this.simulated.release();
  }

  // Turn-end records: the latest is the input Codex is waiting for
  private readTurns() {
    const turns = this.turns?.next() ?? [];
    const last = turns.at(-1);
    if (last === undefined) return;
    this.simulated.setWaiting({ kind: 'text', text: last.text });
    events.publish({ type: 'live.updated', liveId: this.liveId });
    this.simulated.respond();
  }

  // Transcript shown to the simulated user (Contracts section 11): the turn's final answer is given separately in the prompt
  private transcript(waiting: LiveWaiting): TranscriptEntry[] {
    const tail = this.tail;
    if (tail !== null && fs.existsSync(tail)) ingestCodexFile(this.db, tail);
    const sessionId = this.db
      .select({ id: liveSessions.claudeSessionId })
      .from(liveSessions)
      .where(eq(liveSessions.id, this.liveId))
      .get()?.id;
    if (sessionId == null) return [];
    const items = sessionConversation(this.db, sessionId) ?? [];
    if (waiting.kind === 'text' && items.at(-1)?.kind === 'agent') items.pop();
    return items.flatMap((item): TranscriptEntry[] => {
      if (item.kind === 'user') return [{ speaker: 'user', content: item.text }];
      if (item.kind === 'agent') return [{ speaker: 'agent', content: item.text }];
      return [];
    });
  }

  private recordError(error: Error) {
    this.db
      .update(liveProcesses)
      .set({ error: error.message })
      .where(eq(liveProcesses.id, this.processId))
      .run();
    if (this.driver === 'simulated') this.simulated.setDriver('human', 'error');
    else events.publish({ type: 'live.updated', liveId: this.liveId });
  }

  // Start importing this rollout incrementally and reading turn ends from it (remote Codex knows it only once the session id is found)
  follow(tail: string) {
    if (this.tail !== null)
      throw new Error(`Live item ${this.liveId} is already importing ${this.tail}`);
    this.tail = tail;
    this.watching = true;
    this.turns = new RolloutTurns(tail);
    this.watcher = watchSession(this.db, tail, (error) => {
      this.recordError(error);
    });
  }

  private event(kind: LiveEventKind, payload: Record<string, unknown>) {
    this.db
      .insert(liveEvents)
      .values({ liveId: this.liveId, processId: this.processId, at: new Date(), kind, payload })
      .run();
    events.publish({ type: 'live.updated', liveId: this.liveId });
  }

  // Client input: a keystroke switches the driver from simulated user to human (Contracts 14.4); the keystroke is still written
  input(data: string) {
    this.simulated.onInput(data);
    this.pty.write(data);
  }

  // Server shutdown: a local process is ended and awaited; a remote one keeps running in tmux, only the local connection closes
  async shutdown() {
    this.simulated.abort(new Error('Server shutting down'));
    clearInterval(this.turnTimer);
    if (!this.pty.remote) {
      await this.pty.close();
      await this.exited;
      return;
    }
    await this.remote?.close(false);
    await this.watcher?.close();
    this.watching = false;
    await this.pty.close();
  }
}
