import { and, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { type LiveDriver, liveEvents, liveProcesses } from '../db/schema.js';
import type { SettingsStore } from '../runs/settings.js';
import {
  type AgentPrompt,
  type EvalFacts,
  type SimulatedGoal,
  type SimulatedPersona,
  simulateUser,
  type TranscriptEntry,
} from '../runs/simulated-user.js';
import { HttpError } from '../variants/errors.js';
import { pasted } from './keys.js';
import type { LiveTerminal } from './pty.js';
import type { LiveWaiting } from './views.js';

// Why the driver became the human; disconnected: the remote connection dropped (Contracts 31.4, the simulated user drives only while connected)
export type HandBackReason = 'input' | 'done' | 'max-turns' | 'error' | 'manual' | 'disconnected';

// Write the pasted text and the Enter that submits it separately
const SUBMIT_GAP_MS = 300;

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// Mouse reports (SGR 1006) and focus events are not keys: xterm.js sends them on mouse moves and tab switches, so they do not take over
const ESC = String.fromCharCode(27);
const NON_KEY_INPUT = new RegExp(`^(?:${ESC}\\[<\\d+;\\d+;\\d+[Mm]|${ESC}\\[[IO])+$`, 'u');
export const isKeyInput = (data: string) => !NON_KEY_INPUT.test(data);

export interface SimulatedDriverOptions {
  db: Db;
  settings: SettingsStore;
  liveId: string;
  processId: number;
  pty: LiveTerminal;
  // The person the simulated user plays (runs and live items with a task), or the goal this item gave the simulated user (Contracts 34.2);
  // the goal can change while running, so it is read before each answer
  role: () => SimulatedPersona | SimulatedGoal;
  eval: EvalFacts | null;
  // The transcript the simulated user sees for this answer (Contracts section 11)
  transcript: (waiting: LiveWaiting) => TranscriptEntry[];
  // Do not answer while still starting (before Claude Code's first SessionStart)
  starting: () => boolean;
  // Turn AskUserQuestion answers into terminal keys (only Claude Code asks this way)
  answerQuestions: (
    waiting: Extract<LiveWaiting, { kind: 'questions' }>,
    selections: { optionNumbers: number[]; otherAnswer: string }[],
    signal: AbortSignal,
  ) => Promise<void>;
  // Simulated user or import failed: written to this process's error, the driver goes to the human
  onError: (error: Error) => void;
  event: (kind: 'driver' | 'simulated_reply', payload: Record<string, unknown>) => void;
}

// Simulated-user driving and takeover for one process (Contracts 14.4, 34.2), shared by Claude Code's LiveController and Codex's CodexRunner.
// Driven by setWaiting when the agent stops (Claude Code's Stop hook and AskUserQuestion, Codex's task_complete)
export class SimulatedDriver {
  private readonly db: Db;
  // The input the agent is waiting for; null when not waiting
  waiting: LiveWaiting | null = null;
  // The simulated answer being generated or typed; aborted when the driver becomes the human
  private generation: { abort: AbortController; waiting: LiveWaiting } | null = null;

  constructor(private readonly opts: SimulatedDriverOptions) {
    this.db = opts.db;
  }

  get driver(): LiveDriver {
    const row = this.db
      .select({ driver: liveProcesses.driver })
      .from(liveProcesses)
      .where(eq(liveProcesses.id, this.opts.processId))
      .get();
    if (row === undefined) {
      throw new Error(
        `Process ${String(this.opts.processId)} of live item ${this.opts.liveId} does not exist`,
      );
    }
    return row.driver;
  }

  setDriver(driver: LiveDriver, reason: HandBackReason | 'start' | 'release', extra = {}) {
    if (driver === 'human') this.abort(new Error('Driver changed to human'));
    this.db
      .update(liveProcesses)
      .set({ driver })
      .where(eq(liveProcesses.id, this.opts.processId))
      .run();
    this.opts.event('driver', { driver, reason, ...extra });
    if (driver === 'simulated') this.respond();
  }

  // Switching the driver to Simulated user: answers at once if the agent is waiting for input
  release() {
    if (this.opts.starting())
      throw new HttpError(409, 'Starting: the driver stays human until SessionStart arrives');
    if (!this.opts.pty.connected) {
      throw new HttpError(
        409,
        'The remote connection is down and the simulated user drives only while connected; switch the driver to Simulated user after it reconnects',
      );
    }
    this.setDriver('simulated', 'release');
  }

  // Client input: a key turns a simulated-user driver into the human and cancels the answer being generated
  onInput(data: string) {
    if (this.driver === 'simulated' && isKeyInput(data)) this.setDriver('human', 'input');
  }

  abort(reason: Error) {
    this.generation?.abort.abort(reason);
    this.generation = null;
  }

  setWaiting(waiting: LiveWaiting | null) {
    this.waiting = waiting;
    // The earlier prompt is gone, so the answer being generated is void
    this.abort(new Error('The agent is no longer waiting for this answer'));
  }

  // Simulated answers already written to the terminal (the limit in Contracts 14.4)
  private answeredCount(): number {
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(liveEvents)
        .where(
          and(
            eq(liveEvents.liveId, this.opts.liveId),
            eq(liveEvents.kind, 'simulated_reply'),
            sql`json_extract(${liveEvents.payload}, '$.written') = 1`,
          ),
        )
        .get()?.n ?? 0
    );
  }

  respond() {
    const waiting = this.waiting;
    if (
      this.opts.starting() ||
      waiting === null ||
      this.generation !== null ||
      !this.opts.pty.alive ||
      !this.opts.pty.connected ||
      this.driver !== 'simulated'
    ) {
      return;
    }
    const max = this.opts.settings.get().maxUserTurns;
    if (this.answeredCount() >= max) {
      this.setDriver('human', 'max-turns');
      return;
    }
    const abort = new AbortController();
    this.generation = { abort, waiting };
    void this.simulate(waiting, abort).then(
      () => {
        if (this.generation?.abort === abort) this.generation = null;
      },
      (error: unknown) => {
        if (this.generation?.abort === abort) this.generation = null;
        // Aborted because the driver became the human or the agent stopped waiting; the answer is discarded
        if (abort.signal.aborted) {
          const reason: unknown = abort.signal.reason;
          this.opts.event('simulated_reply', {
            written: false,
            discarded: reason instanceof Error ? reason.message : String(reason),
          });
          return;
        }
        this.opts.onError(error instanceof Error ? error : new Error(String(error)));
      },
    );
  }

  private async simulate(waiting: LiveWaiting, abort: AbortController) {
    const prompt: AgentPrompt =
      waiting.kind === 'text'
        ? { kind: 'text', text: waiting.text }
        : { kind: 'questions', questions: waiting.questions };
    const reply = await simulateUser(
      { task: this.opts.role(), eval: this.opts.eval, signal: abort.signal },
      this.opts.transcript(waiting),
      prompt,
    );
    abort.signal.throwIfAborted();
    const record = {
      prompt: waiting.kind,
      ...(waiting.kind === 'questions' ? { questions: waiting.questions } : {}),
      reply: reply.reply,
      answers: reply.answers ?? null,
      done: reply.done,
      reason: reply.reason ?? null,
      costUsd: reply.costUsd,
      model: reply.model,
    };
    if (reply.done) {
      this.opts.event('simulated_reply', { ...record, written: false });
      // In goal mode the reason is recorded with the driver event; the page shows "The simulated user considers it done: <reason>" (Contracts 34.2)
      this.setDriver('human', 'done', { doneReason: reply.reason ?? null });
      return;
    }
    if (waiting.kind === 'text') {
      this.opts.pty.write(pasted(reply.reply));
      await sleep(SUBMIT_GAP_MS);
      abort.signal.throwIfAborted();
      this.opts.pty.write('\r');
    } else {
      const selections = reply.selections;
      if (selections === undefined)
        throw new Error('The simulated user answered AskUserQuestion without option numbers');
      await this.opts.answerQuestions(waiting, selections, abort.signal);
    }
    if (this.waiting === waiting) this.waiting = null;
    this.opts.event('simulated_reply', { ...record, written: true });
  }
}
