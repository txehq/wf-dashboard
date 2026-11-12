import fs from 'node:fs';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { bindLiveSession } from '../bindings/index.js';
import {
  type LiveDriver,
  liveEvents,
  type LiveEventKind,
  liveProcesses,
  liveSessions,
  sessions,
} from '../db/schema.js';
import { events } from '../events.js';
import { sessionConversation } from '../ingest/conversation.js';
import { ingestFile } from '../ingest/ingest.js';
import { type SessionWatcher, watchSession } from '../ingest/watch.js';
import { formatQuestions } from '../runs/runner.js';
import type { SettingsStore } from '../runs/settings.js';
import type {
  EvalFacts,
  SimulatedGoal,
  SimulatedPersona,
  TranscriptEntry,
} from '../runs/simulated-user.js';
import { AskUserQuestionInput } from '../runs/stream.js';
import type { RemoteSessionSync } from '../remote/sync.js';
import { answerMenu } from './keys.js';
import type { LiveTerminal } from './pty.js';
import { type HandBackReason, SimulatedDriver } from './simulated-driver.js';
import type { LiveWaiting } from './views.js';

// stdin of a Claude Code hook (measured fields, Reports/W30 step one); other fields are recorded in live_events as they are
export const HookPayload = z.looseObject({
  hook_event_name: z.string(),
  session_id: z.string(),
  transcript_path: z.string().optional(),
  source: z.string().optional(),
  tool_name: z.string().optional(),
  tool_use_id: z.string().optional(),
  tool_input: z.unknown().optional(),
  last_assistant_message: z.string().optional(),
  background_tasks: z.array(z.unknown()).optional(),
});
export type HookPayload = z.infer<typeof HookPayload>;

// The PreToolUse hook fires before the question menu appears; wait at least this long before reading the screen
const MENU_SETTLE_MS = 1000;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export interface LiveControllerOptions {
  db: Db;
  settings: SettingsStore;
  liveId: string;
  // This run (a row of live_processes)
  processId: number;
  pty: LiveTerminal;
  // The jsonl claude writes the session to (the local copy for a remote process)
  jsonl: string;
  // Driver after the first SessionStart
  initialDriver: LiveDriver;
  // The person the simulated user plays, or this item's goal for the simulated user (Contracts 34.2); the goal can change, read before each answer
  role: () => SimulatedPersona | SimulatedGoal;
  eval: EvalFacts | null;
  // Variant used by the item (null for the local machine's configuration); the session is bound to it after import (Contracts 15.1)
  variantId: string | null;
  // Data directory of the variant, for the binding module to read skills
  dataDir: string;
  // The process's cwd: recorded in the trust event when the local machine's configuration shows the trust prompt
  cwd: string;
  // A process on an SSH host (Contracts 31.6): syncs the remote jsonl reported by SessionStart to the local copy; null for local processes
  remote: RemoteSessionSync | null;
  // A remote process reconnected after a dashboard restart: SessionStart was received long ago, so neither wait for it nor answer the trust prompt
  reattached: boolean;
}

// The Claude Code screen asking whether to trust the cwd (measured in Reports/W30, W39)
const TRUST_PROMPT = 'Is this a project you created or one you trust?';
const TRUST_YES = /❯.*Yes, I trust this folder/u;
const TRUST_POLL_MS = 200;

// A running Live session: hook-driven state, simulated-user driving and takeover (Contracts 14.4)
export class LiveController {
  private readonly db: Db;
  readonly liveId: string;
  readonly engine = 'claude';
  readonly processId: number;
  readonly pty: LiveTerminal;
  private jsonl: string;
  private watcher: SessionWatcher;
  // Whether incremental import is still running (GET /api/diagnostics); stops after the process exits
  watching = true;
  private started = false;
  // Sessions already bound to the variant
  private readonly bound = new Set<string>();
  private waitingSince = 0;
  private readonly simulated: SimulatedDriver;
  readonly exited: Promise<void>;

  constructor(private readonly opts: LiveControllerOptions) {
    this.db = opts.db;
    this.liveId = opts.liveId;
    this.processId = opts.processId;
    this.pty = opts.pty;
    this.jsonl = opts.jsonl;
    this.simulated = new SimulatedDriver({
      db: opts.db,
      settings: opts.settings,
      liveId: opts.liveId,
      processId: opts.processId,
      pty: opts.pty,
      role: opts.role,
      eval: opts.eval,
      transcript: (waiting) => this.transcript(waiting),
      starting: () => !this.started,
      answerQuestions: async (waiting, selections, signal) => {
        const wait = this.waitingSince + MENU_SETTLE_MS - Date.now();
        if (wait > 0) await sleep(wait);
        await answerMenu(this.pty, waiting.questions, selections, signal);
      },
      onError: (error) => {
        this.recordError(error);
      },
      event: (kind, payload) => {
        this.event(kind, payload);
      },
    });
    this.watcher = watchSession(this.db, this.jsonl, (error) => {
      this.recordError(error);
    });
    this.bindImported();
    const stopBinding = events.subscribe((event) => {
      if (event.type === 'session.updated') this.bindImported();
    });
    this.started = opts.reattached;
    const stopTrust =
      opts.variantId === null && !opts.reattached ? this.answerTrust() : () => undefined;
    const stopConnection = this.pty.onConnection((connected) => {
      void this.onConnection(connected);
    });
    this.exited = this.pty.exited.then(async (exit) => {
      stopBinding();
      stopTrust();
      stopConnection();
      this.simulated.abort(new Error('Process exited'));
      await this.opts.remote?.close(true);
      await this.watcher.close();
      this.watching = false;
      if (fs.existsSync(this.jsonl)) ingestFile(this.db, this.jsonl);
      this.opts.remote?.mark();
      // If the process ends quickly, the session's first import happens just above: bind it to this run's variant too
      this.bindImported();
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

  // Remote disconnect and reconnect (Contracts 31.4): on disconnect the simulated user stops driving and the driver becomes human; on
  // reconnect the session is synced back first, then "waiting for input" and unanswered AskUserQuestion are restored from it
  private async onConnection(connected: boolean) {
    if (!connected) {
      if (!this.pty.alive) return;
      this.event('disconnect', {});
      if (this.driver === 'simulated') this.setDriver('human', 'disconnected');
      return;
    }
    this.event('reconnect', {});
    if (!this.started) return;
    await this.opts.remote?.syncNow();
    this.restoreWaiting();
  }

  // Hooks lost while disconnected: judge from the last conversation item whether Claude Code is waiting for input
  private restoreWaiting() {
    if (fs.existsSync(this.jsonl)) ingestFile(this.db, this.jsonl);
    const items = sessionConversation(this.db, this.sessionId()) ?? [];
    const last = items.findLast((item) => item.kind !== 'notice');
    if (last?.kind === 'agent') {
      this.setWaiting({ kind: 'text', text: last.text });
    } else if (last?.kind === 'question' && last.answers === null) {
      const { questions } = AskUserQuestionInput.parse({ questions: last.questions });
      this.setWaiting({ kind: 'questions', toolUseId: last.toolCallId, questions });
    } else {
      this.setWaiting(null);
    }
  }

  get starting(): boolean {
    return !this.started;
  }

  // Trust prompt for the local machine's configuration (Contracts 14.2): the user's ~/.claude.json is untouched; before the first
  // SessionStart, when the screen copy shows the prompt, move the cursor to "Yes, I trust this folder" and press Enter, then Claude Code
  // records the trust itself. Returns a function that stops watching
  private answerTrust(): () => void {
    let checking = false;
    let answered = false;
    const check = async () => {
      if (checking || answered || this.started || !this.pty.alive) return;
      checking = true;
      const lines = await this.pty.viewport();
      checking = false;
      if (!lines.some((l) => l.includes(TRUST_PROMPT))) return;
      if (lines.some((l) => TRUST_YES.test(l))) {
        answered = true;
        this.pty.write('\r');
        // Record the prompt on the screen copy at the time of answering
        this.event('trust', { cwd: this.opts.cwd, screen: lines.filter((l) => l.trim() !== '') });
        return;
      }
      // Cursor on another option (default "No, exit"): move down one line and look again on the next check
      this.pty.write('\u001b[B');
    };
    const timer = setInterval(() => {
      if (answered || this.started) {
        clearInterval(timer);
        return;
      }
      void check();
    }, TRUST_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }

  // After its first import, the Live session is bound to the item's variant; not for the local machine's configuration. A new session
  // after /clear is bound the same way
  private bindImported() {
    const variantId = this.opts.variantId;
    if (variantId === null) return;
    const sessionId = this.sessionId();
    if (this.bound.has(sessionId)) return;
    const row = this.db
      .select({ id: sessions.id })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    if (row === undefined) return;
    this.bound.add(sessionId);
    bindLiveSession(this.db, this.opts.dataDir, sessionId, variantId);
  }

  get driver(): LiveDriver {
    return this.simulated.driver;
  }

  private event(kind: LiveEventKind, payload: Record<string, unknown>) {
    this.db
      .insert(liveEvents)
      .values({ liveId: this.liveId, processId: this.processId, at: new Date(), kind, payload })
      .run();
    events.publish({ type: 'live.updated', liveId: this.liveId });
  }

  // Simulated-user and import errors: written to this process's error and handed to the human; the process keeps running
  private recordError(error: Error) {
    this.db
      .update(liveProcesses)
      .set({ error: error.message })
      .where(eq(liveProcesses.id, this.processId))
      .run();
    if (this.driver === 'simulated') this.setDriver('human', 'error');
    else events.publish({ type: 'live.updated', liveId: this.liveId });
  }

  setDriver(driver: LiveDriver, reason: HandBackReason | 'start' | 'release') {
    this.simulated.setDriver(driver, reason);
  }

  // "Hand back": the driver becomes the simulated user, which answers at once if Claude Code is waiting for input
  release() {
    const waiting = this.waiting;
    // Do not wait on an AskUserQuestion the human already answered in the terminal
    if (waiting?.kind === 'questions' && this.questionAnswered(waiting.toolUseId)) {
      this.simulated.waiting = null;
    }
    this.simulated.release();
  }

  private questionAnswered(toolUseId: string): boolean {
    if (fs.existsSync(this.jsonl)) ingestFile(this.db, this.jsonl);
    const found = this.db.$client
      .prepare<[string, string], { result: string | null }>(
        `select json_extract(j.value, '$.result') as result
         from requests r, json_each(r.tool_calls) j
         where r.session_id = ? and r.agent_id is null and json_extract(j.value, '$.id') = ?`,
      )
      .get(this.sessionId(), toolUseId);
    return found !== undefined && found.result !== null;
  }

  private sessionId(): string {
    const row = this.db
      .select({ id: liveSessions.claudeSessionId })
      .from(liveSessions)
      .where(eq(liveSessions.id, this.liveId))
      .get();
    if (row === undefined) throw new Error(`Live item ${this.liveId} does not exist`);
    // A Claude Code item has a session id from creation; only a Codex draft item can be temporarily null
    if (row.id === null) throw new Error(`Live item ${this.liveId} has no session id`);
    return row.id;
  }

  // Client input: a key press turns simulated driving into human and cancels the answer being generated; the key is still written
  input(data: string) {
    this.simulated.onInput(data);
    this.pty.write(data);
  }

  hook(payload: HookPayload) {
    this.event('hook', payload);
    switch (payload.hook_event_name) {
      case 'SessionStart':
        this.onSessionStart(payload);
        break;
      case 'UserPromptSubmit':
        this.setWaiting(null);
        break;
      case 'PreToolUse': {
        if (payload.tool_name !== 'AskUserQuestion') break;
        const toolUseId = z.string().parse(payload.tool_use_id);
        const { questions } = AskUserQuestionInput.parse(payload.tool_input);
        this.setWaiting({ kind: 'questions', toolUseId, questions });
        break;
      }
      case 'Stop': {
        // With background tasks still running, Claude Code starts the next turn itself without waiting for the user (Spikes/Claude CLI section 8)
        const background = payload.background_tasks ?? [];
        this.setWaiting(
          background.length > 0
            ? null
            : { kind: 'text', text: payload.last_assistant_message ?? '' },
        );
        break;
      }
      default:
        break;
    }
    this.simulated.respond();
  }

  private onSessionStart(payload: HookPayload) {
    // /clear and similar changed the session: import the new jsonl from now on
    if (payload.session_id !== this.sessionId()) {
      this.db
        .update(liveSessions)
        .set({ claudeSessionId: payload.session_id })
        .where(eq(liveSessions.id, this.liveId))
        .run();
    }
    // The jsonl location reported by Claude Code wins: the local machine's configuration sets no CLAUDE_CONFIG_DIR, so Claude Code ignores
    // CLAUDE_CODE_PROJECT_DIR_NAME and writes the session in the project directory for the cwd. A remote process reports a remote path,
    // which is synced to a local copy and the copy imported (Contracts 31.6)
    const reported = z.string().parse(payload.transcript_path);
    const transcript = this.opts.remote === null ? reported : this.opts.remote.follow(reported);
    if (transcript !== this.jsonl) {
      void this.watcher.close();
      this.jsonl = transcript;
      this.watcher = watchSession(this.db, this.jsonl, (error) => {
        this.recordError(error);
      });
    }
    // A resumed session stops at the input box after starting, waiting for the user to reply to the last turn
    if (payload.source === 'resume') this.setWaiting(this.lastAgentTurn());
    if (!this.started) {
      this.started = true;
      if (this.opts.initialDriver === 'simulated') this.setDriver('simulated', 'start');
      else events.publish({ type: 'live.updated', liveId: this.liveId });
    }
  }

  // Orca-hosted terminals have no hooks (Contracts 35.4): import starts here once the topology sync finds the agent's session; also
  // called when /clear changes the session later
  followTranscript(transcript: string) {
    if (transcript === this.jsonl) return;
    void this.watcher.close();
    this.jsonl = transcript;
    this.watcher = watchSession(this.db, this.jsonl, (error) => {
      this.recordError(error);
    });
    this.bindImported();
  }

  // When Orca reports the agent stopped (idle or awaiting an answer), judge from the conversation what it waits for and answer as usual
  // under simulated driving; when it reports working, stop waiting. Called only on state changes
  observeAgent(state: 'working' | 'stopped') {
    if (state === 'working') {
      if (this.waiting !== null) this.setWaiting(null);
      return;
    }
    this.restoreWaiting();
    this.simulated.respond();
  }

  private lastAgentTurn(): LiveWaiting | null {
    if (fs.existsSync(this.jsonl)) ingestFile(this.db, this.jsonl);
    const items = sessionConversation(this.db, this.sessionId()) ?? [];
    const last = items.findLast((item) => item.kind !== 'notice');
    return last?.kind === 'agent' ? { kind: 'text', text: last.text } : null;
  }

  private setWaiting(waiting: LiveWaiting | null) {
    this.simulated.setWaiting(waiting);
    this.waitingSince = Date.now();
    events.publish({ type: 'live.updated', liveId: this.liveId });
  }

  // Transcript (Contracts section 11): the latest turn's text or the current question is given separately in the prompt
  private transcript(waiting: LiveWaiting): TranscriptEntry[] {
    if (fs.existsSync(this.jsonl)) ingestFile(this.db, this.jsonl);
    const items = sessionConversation(this.db, this.sessionId()) ?? [];
    if (waiting.kind === 'text' && items.at(-1)?.kind === 'agent') items.pop();
    const out: TranscriptEntry[] = [];
    for (const item of items) {
      if (item.kind === 'user') out.push({ speaker: 'user', content: item.text });
      else if (item.kind === 'agent') out.push({ speaker: 'agent', content: item.text });
      else if (item.kind === 'question') {
        if (waiting.kind === 'questions' && item.toolCallId === waiting.toolUseId) continue;
        out.push({ speaker: 'agent', content: formatQuestions(item.questions) });
        if (item.answers !== null) {
          out.push({
            speaker: 'user',
            content: Object.entries(item.answers)
              .map(([q, a]) => `${q} → ${a}`)
              .join('\n'),
          });
        }
      }
    }
    return out;
  }

  // Server shutdown: a local process is ended and awaited; a remote process keeps running in tmux, only sync and import stop and the local
  // connection is closed
  async shutdown() {
    this.simulated.abort(new Error('Server shutting down'));
    if (!this.pty.remote) {
      await this.pty.close();
      await this.exited;
      return;
    }
    await this.opts.remote?.close(false);
    await this.watcher.close();
    this.watching = false;
    await this.pty.close();
  }
}
