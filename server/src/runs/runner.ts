import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  type AskQuestion,
  type GradingStatus,
  type RunStatus,
  runs,
  terminalRunStatuses,
} from '../db/schema.js';
import { events } from '../events.js';
import { readPr } from '../external/github.js';
import type { RunRepos } from '../external/run-repos.js';
import { gradeRun } from '../grading/index.js';
import { ingestFile } from '../ingest/ingest.js';
import { type SessionWatcher, watchSession } from '../ingest/watch.js';
import { featureDir } from '../stages/artifacts.js';
import { publishStageChanges, type StageChange, updateStages } from '../stages/report.js';
import { loadTask } from '../tasks/loader.js';
import type { Task } from '../tasks/schema.js';
import { HttpError } from '../variants/errors.js';
import type { Variants } from '../variants/index.js';
import { evalSpecOf, workflowOfVariant } from '../workflows/index.js';
import { type EvalSpec, rubricOf } from '../workflows/schema.js';
import { recordAcceptanceReport, watchAcceptanceReport } from './acceptance-report.js';
import { ClaudeProcess } from './claude-process.js';
import { refreshRunCost, watchRunCost } from './cost-refresh.js';
import { scanCrossRunRefs } from './cross-run-refs.js';
import { scanSourceRefs } from './source-refs.js';
import { recordFriction } from './friction.js';
import { launchSpec, prepareRun } from './prepare.js';
import { RubricArtifacts } from './rubric-artifacts.js';
import { addMessage, listMessages, upsertArtifact } from './records.js';
import type { SettingsStore } from './settings.js';
import {
  type AgentPrompt,
  type SimulatedReply,
  simulateUser,
  type SimulatedUserContext,
  type TranscriptEntry,
} from './simulated-user.js';
import {
  AskUserQuestionInput,
  type ControlRequestEvent,
  isType,
  type StreamEvent,
} from './stream.js';
import type { TurnTransition } from './turn-tracker.js';
import type { Pending, RunMode } from './views.js';

export interface RunnerDeps {
  db: Db;
  variants: Variants;
  settings: SettingsStore;
  vaultDir: string;
  product: string;
  runsDir: string;
  // The run's repo on GitHub (Contracts 7.2)
  repos: RunRepos;
}

// Time to wait for the CLI to wrap up on cancel and finish; SIGTERM after it (Spikes/Claude CLI section 7)
const SETTLE_TIMEOUT_MS = 60_000;
const PR_POLL_MS = 60_000;
const DENY_MESSAGE = 'The eval environment does not allow this operation; continue in another way.';

type RunRow = typeof runs.$inferSelect;

function timeout(ms: number): Promise<'timeout'> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve('timeout');
    }, ms).unref();
  });
}

export function formatQuestions(questions: AskQuestion[]): string {
  return questions
    .map((q) =>
      [
        `${q.header ? `[${q.header}] ` : ''}${q.question}${q.multiSelect ? ' (multiple choice)' : ''}`,
        ...q.options.map((o) => `- ${o.label}${o.description ? `: ${o.description}` : ''}`),
      ].join('\n'),
    )
    .join('\n\n');
}

const formatAnswers = (answers: Record<string, string>) =>
  Object.entries(answers)
    .map(([q, a]) => `${q} → ${a}`)
    .join('\n');

// The full lifecycle of a run: prepare, drive the claude subprocess and simulated user, takeover, finish and grading
export class RunDriver {
  mode: RunMode = 'simulated';
  pending: Pending | null = null;
  readonly done: Promise<void>;

  private readonly db: Db;
  private task!: Task;
  // Eval config of the workflow of the run's variant: prepare, initial message, done condition and grading follow its building blocks (Contracts 16.2)
  private stage!: EvalSpec;
  private proc: ClaudeProcess | null = null;
  private rubricArtifacts: RubricArtifacts | null = null;
  private sessionWatcher: SessionWatcher | null = null;
  private unsubscribe: (() => void) | null = null;
  private prTimer: NodeJS.Timeout | null = null;
  private prPolling = false;
  private jsonl: string | null = null;
  // All reply text of the main session since the last answer: a question may appear before tool calls or background tasks
  private turnText: string[] = [];
  // Agent message seq of pending; the simulated user's transcript stops before it
  private pendingSeq = -1;
  private readonly questionInputs = new Map<string, Record<string, unknown>>();
  private simulating = false;
  private ending: 'finish' | 'cancel' | null = null;
  private shuttingDown = false;
  // Aborts gradeRun on grading cancel and server shutdown: ends grading subprocesses (npm ci, hidden tests) and judge requests
  private readonly gradingAbort = new AbortController();
  // Aborts the prepare-stage waits on server shutdown (default branch, starting code CI)
  private readonly stopping = new AbortController();
  private failure: ((error: Error) => void) | null = null;
  private readonly failed: Promise<never>;

  constructor(
    private readonly deps: RunnerDeps,
    readonly runId: string,
  ) {
    this.db = deps.db;
    this.failed = new Promise<never>((_, reject) => {
      this.failure = reject;
    });
    // Even if drive never awaits failed, the rejection must not become an unhandled Promise
    this.failed.catch(() => undefined);
    this.done = this.drive().then(
      () => {
        this.cleanup();
      },
      async (error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[run ${runId}] failed`, err);
        await this.abort();
        this.setStatus('failed', { error: err.message, endedAt: new Date() });
        this.cleanup();
      },
    );
  }

  // Errors in callbacks (stdout parsing, simulated user) all fail the run
  fail = (error: Error) => {
    this.failure?.(error);
  };

  private guard(work: Promise<unknown>) {
    work.catch((error: unknown) => {
      this.fail(error instanceof Error ? error : new Error(String(error)));
    });
  }

  private row(): RunRow {
    const row = this.db.select().from(runs).where(eq(runs.id, this.runId)).get();
    if (row === undefined) throw new Error(`Run ${this.runId} does not exist`);
    return row;
  }

  private update(values: Partial<RunRow>) {
    this.db.update(runs).set(values).where(eq(runs.id, this.runId)).run();
  }

  private setStatus(status: RunStatus, values: Partial<RunRow> = {}) {
    this.update({ ...values, status });
    events.publish({ type: 'run.status', runId: this.runId, status });
    // The last stage of a terminal run's session is done (Contracts section 5)
    if (terminalRunStatuses.includes(status)) {
      const { sessionId } = this.row();
      const changes = updateStages(this.db, sessionId);
      publishStageChanges(sessionId, changes);
      for (const change of changes) this.publishStage(change);
    }
  }

  private publishStage(change: StageChange) {
    events.publish({ type: 'run.stage', runId: this.runId, ...change });
  }

  private setPending(pending: Pending | null) {
    this.pending = pending;
    events.publish({ type: 'run.pending', runId: this.runId, pending });
  }

  get status(): RunStatus {
    return this.row().status;
  }

  private runDir() {
    return path.join(this.deps.runsDir, this.runId);
  }

  private async drive() {
    const run = this.row();
    this.task = loadTask(this.db, run.taskId);
    this.stage = evalSpecOf(this.db, workflowOfVariant(this.db, run.variantId));
    this.setStatus('preparing', { startedAt: new Date() });
    const initial = await this.prepare(run);
    // prepare wrote the repo
    this.start(this.row(), initial);
    const proc = this.proc;
    if (proc === null) throw new Error('Claude process did not start');
    const exit = await Promise.race([proc.exited, this.failed]);
    if (this.shuttingDown) throw new Error('Server shut down, run interrupted');
    await this.teardown();
    if (this.ending === 'cancel') {
      this.setStatus('cancelled', { endedAt: new Date() });
      // A cancelled run still grades the artifacts already written and stays cancelled (Contracts 7.5);
      // on a grading error, grading is recorded as failed with the raw text and status stays cancelled
      await this.grade().then(
        () => undefined,
        () => undefined,
      );
      this.updateCost();
      return;
    }
    if (this.ending !== 'finish') {
      throw new Error(
        `Claude process exited unexpectedly (code=${String(exit.code)}, signal=${String(exit.signal)})`,
      );
    }
    this.setStatus('grading');
    // Grading cancelled from the page: grading is failed with the reason, status cancelled; on server shutdown the run fails as usual
    const cancelled = await this.grade().then(
      () => false,
      (error: unknown) => {
        if (this.gradingAbort.signal.aborted && !this.shuttingDown) return true;
        throw error;
      },
    );
    this.updateCost();
    if (cancelled) {
      this.setStatus('cancelled', { endedAt: new Date() });
      return;
    }
    this.setStatus('succeeded', { endedAt: new Date() });
  }

  // Contracts 7.6
  private async grade() {
    this.setGrading('running', null);
    await Promise.race([gradeRun(this.db, this.runId, this.gradingAbort.signal), this.failed]).then(
      () => {
        this.setGrading('done', null);
      },
      (error: unknown) => {
        this.setGrading('failed', error instanceof Error ? error.message : String(error));
        throw error;
      },
    );
  }

  private setGrading(status: GradingStatus, error: string | null) {
    this.update({ gradingStatus: status, gradingError: error });
    events.publish({ type: 'run.status', runId: this.runId, status: this.row().status });
  }

  // Contracts 7.2, 16.2: external objects, workspace and vault; returns the initial message built from the template
  private async prepare(run: RunRow): Promise<string> {
    fs.mkdirSync(this.runDir(), { recursive: true });
    return prepareRun({
      db: this.db,
      repos: this.deps.repos,
      vaultDir: this.deps.vaultDir,
      product: this.deps.product,
      run,
      task: this.task,
      stage: this.stage,
      signal: this.stopping.signal,
    });
  }

  private simulatedUserContext(): SimulatedUserContext {
    const run = this.row();
    return {
      task: {
        stage: this.stage,
        persona: this.task.persona,
        hiddenRequirements: this.task.hiddenRequirements,
      },
      eval: {
        runId: this.runId,
        repo: run.githubRepo,
        ticket: run.linearIssueIdentifier,
        product: this.deps.product,
      },
    };
  }

  private start(run: RunRow, initial: string) {
    if (this.shuttingDown) throw new Error('Server shut down, run interrupted');
    this.deps.variants.refreshAuthEnv(run.variantId);
    const runtime = this.deps.variants.runtimeEnv(run.variantId);
    const { env, variantArgs } = launchSpec(runtime, run, this.stage, this.deps);
    const jsonl = path.join(
      runtime.env.CLAUDE_CONFIG_DIR,
      'projects',
      this.runId,
      `${run.sessionId}.jsonl`,
    );
    this.jsonl = jsonl;
    this.sessionWatcher = watchSession(this.db, jsonl, this.fail);

    const rubric = rubricOf(this.stage);
    if (rubric !== null) {
      this.rubricArtifacts = new RubricArtifacts(
        this.db,
        this.runId,
        featureDir(this.deps.vaultDir, this.deps.product, this.runId),
        rubric,
      );
      this.rubricArtifacts.record();
    }
    // Eval kinds with a repo copy: poll the PR and record the acceptance report
    const tracksPr = this.stage.prepare.includes('repo-copy');
    if (tracksPr) {
      this.prTimer = setInterval(() => {
        this.guard(this.pollPr());
      }, PR_POLL_MS);
    }
    // Stages are split when the session is imported (updateStages in stages/report); here they are only forwarded as run.stage
    const stopSession = events.subscribe((event) => {
      if (event.type === 'session.updated' && event.sessionId === run.sessionId) {
        this.rubricArtifacts?.record();
      }
      if (event.type === 'stage.changed' && event.sessionId === run.sessionId) {
        this.publishStage({ workflow: event.workflow, stage: event.stage, status: event.status });
      }
    });
    const stopCost = watchRunCost(this.db, this.runId, run.sessionId, this.fail);
    const stopAcceptance = tracksPr
      ? watchAcceptanceReport(this.db, this.runId, run.sessionId, this.fail)
      : () => undefined;
    this.unsubscribe = () => {
      stopSession();
      stopCost();
      stopAcceptance();
    };

    this.proc = new ClaudeProcess({
      sessionId: run.sessionId,
      cwd: run.workspacePath,
      env,
      variantArgs,
      sandboxProfile: this.deps.variants.sandboxProfile(
        run.variantId,
        this.runId,
        this.deps.runsDir,
      ),
      logDir: this.runDir(),
      onEvent: (event) => {
        this.onEvent(event);
      },
      onTurn: (transition) => {
        this.onTurn(transition);
      },
      onError: this.fail,
    });
    this.setStatus('running');
    addMessage(this.db, this.runId, {
      role: 'system',
      content: initial,
      payload: { kind: 'initial' },
    });
    this.proc.sendUser(initial);
  }

  private onEvent(event: StreamEvent) {
    if (isType(event, 'assistant') && event.parent_tool_use_id === null) {
      for (const block of event.message.content) {
        if (block.type === 'text' && typeof block.text === 'string') this.turnText.push(block.text);
      }
    } else if (isType(event, 'control_request')) {
      this.onControlRequest(event);
    }
  }

  private onTurn(transition: TurnTransition) {
    if (transition.state !== 'idle' || this.ending !== null) return;
    const text = this.turnText.join('\n\n').trim();
    this.turnText = [];
    const message = addMessage(this.db, this.runId, { role: 'agent', content: text });
    this.pendingSeq = message.seq;
    this.setPending({ kind: 'text', text, since: Date.now() });
    this.guard(this.afterTurn());
    this.respondIfSimulated();
  }

  private async afterTurn() {
    this.rubricArtifacts?.record();
    this.updateCost();
    this.update({
      crossRunRefs: scanCrossRunRefs(this.db, this.runId),
      sourceRefs: scanSourceRefs(this.db, this.runId),
    });
    await recordFriction(this.db, this.runId, this.row().sessionId);
    if (this.stage.prepare.includes('repo-copy')) {
      recordAcceptanceReport(this.db, this.runId, this.row().sessionId);
      await this.pollPr();
    }
  }

  private onControlRequest(event: ControlRequestEvent) {
    const proc = this.proc;
    if (proc === null)
      throw new Error('Received control_request before the claude process started');
    const { request } = event;
    if (request.subtype !== 'can_use_tool') {
      this.fail(new Error(`Unhandled control_request: ${JSON.stringify(request)}`));
      return;
    }
    if (request.tool_name === 'AskUserQuestion' && this.ending === null) {
      const input = AskUserQuestionInput.parse(request.input);
      this.questionInputs.set(event.request_id, input);
      const questions: AskQuestion[] = input.questions;
      const message = addMessage(this.db, this.runId, {
        role: 'agent',
        content: formatQuestions(questions),
        payload: { kind: 'question', requestId: event.request_id, questions },
      });
      this.pendingSeq = message.seq;
      this.setPending({
        kind: 'questions',
        requestId: event.request_id,
        questions,
        since: Date.now(),
      });
      this.respondIfSimulated();
      return;
    }
    // All other permission requests (only safety checks such as deleting critical paths) are denied and recorded
    proc.respond(event.request_id, { behavior: 'deny', message: DENY_MESSAGE });
    const toolName = request.tool_name ?? '(unknown)';
    addMessage(this.db, this.runId, {
      role: 'system',
      content: `Denied the permission request for ${toolName}${request.decision_reason ? `: ${request.decision_reason}` : ''}`,
      payload: {
        kind: 'denied',
        toolName,
        input: request.input ?? null,
        reason: request.decision_reason ?? null,
      },
    });
  }

  private transcript(): TranscriptEntry[] {
    const out: TranscriptEntry[] = [];
    for (const m of listMessages(this.db, this.runId)) {
      if (m.seq >= this.pendingSeq) break;
      if (m.role === 'agent') out.push({ speaker: 'agent', content: m.content });
      else if (m.role === 'simulated_user' || m.role === 'human') {
        out.push({ speaker: 'user', content: m.content });
      } else if (m.payload?.kind === 'initial') out.push({ speaker: 'user', content: m.content });
    }
    return out;
  }

  private respondIfSimulated() {
    const idle = this.mode === 'simulated' && !this.simulating && this.ending === null;
    if (!idle || this.pending === null) return;
    this.guard(this.simulate(this.pending));
  }

  private async simulate(pending: Pending) {
    const max = this.deps.settings.get().maxUserTurns;
    const answered = listMessages(this.db, this.runId).filter(
      (m) => m.role === 'simulated_user',
    ).length;
    if (answered >= max) {
      throw new Error(
        `Simulated user reached the answer limit of ${String(max)} and the conversation has not ended`,
      );
    }
    this.simulating = true;
    const prompt: AgentPrompt =
      pending.kind === 'text'
        ? { kind: 'text', text: pending.text }
        : { kind: 'questions', questions: pending.questions };
    const reply = await Promise.race([
      simulateUser(this.simulatedUserContext(), this.transcript(), prompt),
      this.failed,
    ]);
    this.simulating = false;
    if (this.pending !== pending || this.mode !== 'simulated' || this.ending !== null) {
      // Taken over or ending during generation: the answer is discarded, its cost still counts
      addMessage(this.db, this.runId, {
        role: 'system',
        content: `Simulated user answer not sent (${this.ending === null ? 'taken over' : 'run is ending'}): ${reply.reply}`,
        costUsd: reply.costUsd,
        payload: { kind: 'event', event: 'simulated-reply-discarded' },
      });
      this.respondIfSimulated();
      return;
    }
    this.deliver(pending, reply, 'simulated_user');
    this.updateCost();
  }

  private deliver(
    pending: Pending,
    reply: Pick<SimulatedReply, 'reply' | 'answers' | 'done'> & { costUsd: number },
    role: 'simulated_user' | 'human',
  ) {
    const proc = this.proc;
    if (proc === null) throw new Error('Claude process has not started');
    if (pending.kind === 'text') {
      addMessage(this.db, this.runId, {
        role,
        content: reply.reply,
        costUsd: reply.costUsd,
        payload: { kind: 'reply', done: reply.done },
      });
      this.setPending(null);
      if (reply.done) this.finishProcess();
      else proc.sendUser(reply.reply);
      return;
    }
    const answers = reply.answers;
    if (answers === undefined) throw new Error('Answering AskUserQuestion requires answers');
    const input = this.questionInputs.get(pending.requestId);
    if (input === undefined) throw new Error(`No input for control_request ${pending.requestId}`);
    this.questionInputs.delete(pending.requestId);
    proc.respond(pending.requestId, { behavior: 'allow', updatedInput: { ...input, answers } });
    addMessage(this.db, this.runId, {
      role,
      content: formatAnswers(answers),
      costUsd: reply.costUsd,
      payload: {
        kind: 'answers',
        requestId: pending.requestId,
        questions: pending.questions,
        answers,
      },
    });
    this.setPending(null);
  }

  // An unanswered AskUserQuestion is denied on finish and cancel so the CLI can wrap up
  private denyPendingQuestion() {
    const pending = this.pending;
    if (pending?.kind !== 'questions' || this.proc === null) return;
    this.questionInputs.delete(pending.requestId);
    this.proc.respond(pending.requestId, { behavior: 'deny', message: 'The run has ended.' });
    this.setPending(null);
  }

  // Close stdin: the CLI exits after finishing the current turn and background tasks, then grading starts
  private finishProcess() {
    this.ending = 'finish';
    this.denyPendingQuestion();
    this.setPending(null);
    this.proc?.closeStdin();
    void this.terminateAfter(SETTLE_TIMEOUT_MS * 30);
  }

  private async terminateAfter(ms: number) {
    const proc = this.proc;
    if (proc === null) return;
    if ((await Promise.race([proc.exited, timeout(ms)])) === 'timeout') proc.terminate();
  }

  private requireRunning() {
    if (this.status !== 'running' || this.proc === null) {
      throw new HttpError(409, `Run ${this.runId} is not running`);
    }
    if (this.ending !== null) throw new HttpError(409, `Run ${this.runId} is ending`);
  }

  takeover() {
    this.requireRunning();
    if (this.mode === 'human') throw new HttpError(409, `Run ${this.runId} is already taken over`);
    this.mode = 'human';
    this.update({ humanIntervened: true });
    addMessage(this.db, this.runId, {
      role: 'system',
      content: 'The page took over the conversation',
      payload: { kind: 'event', event: 'takeover' },
    });
    events.publish({ type: 'run.pending', runId: this.runId, pending: this.pending });
  }

  release() {
    this.requireRunning();
    if (this.mode !== 'human') throw new HttpError(409, `Run ${this.runId} is not taken over`);
    this.mode = 'simulated';
    addMessage(this.db, this.runId, {
      role: 'system',
      content: 'Conversation handed back to the simulated user',
      payload: { kind: 'event', event: 'release' },
    });
    this.respondIfSimulated();
  }

  private requireHuman() {
    this.requireRunning();
    if (this.mode !== 'human') throw new HttpError(409, `Run ${this.runId} is not taken over`);
  }

  reply(text: string) {
    this.requireHuman();
    const pending = this.pending;
    if (pending?.kind !== 'text')
      throw new HttpError(409, 'No text question is waiting for an answer');
    this.deliver(pending, { reply: text, done: false, costUsd: 0 }, 'human');
  }

  answer(answers: Record<string, string>) {
    this.requireHuman();
    const pending = this.pending;
    if (pending?.kind !== 'questions')
      throw new HttpError(409, 'No AskUserQuestion is waiting for an answer');
    const expected = pending.questions.map((q) => q.question).sort();
    if (JSON.stringify(Object.keys(answers).sort()) !== JSON.stringify(expected)) {
      throw new HttpError(
        400,
        `The keys of answers must be all the questions: ${JSON.stringify(expected)}`,
      );
    }
    this.deliver(pending, { reply: '', answers, done: false, costUsd: 0 }, 'human');
  }

  finish() {
    this.requireHuman();
    addMessage(this.db, this.runId, {
      role: 'system',
      content: 'The page finished the run',
      payload: { kind: 'event', event: 'finish' },
    });
    this.finishProcess();
  }

  // Grading in progress (grading, or grading written artifacts after cancel): abort grading and end its subprocesses
  get gradingCancellable(): boolean {
    const row = this.row();
    return (
      !this.gradingAbort.signal.aborted &&
      row.gradingStatus === 'running' &&
      (row.status === 'grading' || row.status === 'cancelled')
    );
  }

  private async cancelGrading() {
    addMessage(this.db, this.runId, {
      role: 'system',
      content: 'The page cancelled grading',
      payload: { kind: 'event', event: 'cancel-grading' },
    });
    this.gradingAbort.abort(new Error('Grading cancelled from the page'));
    await this.done;
  }

  // interrupt control message → wait for result → close stdin; SIGTERM on timeout. Cancelling during grading aborts grading
  async cancel() {
    if (this.gradingCancellable) {
      await this.cancelGrading();
      return;
    }
    this.requireRunning();
    const proc = this.proc;
    if (proc === null) throw new Error('Claude process has not started');
    this.ending = 'cancel';
    addMessage(this.db, this.runId, {
      role: 'system',
      content: 'The page cancelled the run',
      payload: { kind: 'event', event: 'cancel' },
    });
    this.denyPendingQuestion();
    this.setPending(null);
    if (proc.tracker.state !== 'idle') {
      const settled = new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (proc.tracker.state === 'idle' || proc.tracker.state === 'awaiting_background') {
            clearInterval(check);
            resolve();
          }
        }, 100);
        void proc.exited.then(() => {
          clearInterval(check);
          resolve();
        });
      });
      await Promise.race([proc.interrupt(), proc.exited, timeout(SETTLE_TIMEOUT_MS)]);
      await Promise.race([settled, timeout(SETTLE_TIMEOUT_MS)]);
    }
    proc.closeStdin();
    await this.terminateAfter(SETTLE_TIMEOUT_MS);
    await this.done;
  }

  private async pollPr() {
    const repo = this.row().githubRepo;
    if (this.prPolling || repo === null) return;
    this.prPolling = true;
    const pr = await readPr(repo);
    this.prPolling = false;
    if (pr === null) return;
    if (this.row().prUrl !== pr.url) this.update({ prUrl: pr.url });
    const { url, ...state } = pr;
    upsertArtifact(this.db, this.runId, 'pr', url, JSON.stringify(state, null, 2));
  }

  private updateCost() {
    refreshRunCost(this.db, this.runId);
  }

  // After the process exits: read the jsonl and artifacts one last time, stop watching
  private async teardown() {
    if (this.prTimer !== null) clearInterval(this.prTimer);
    this.prTimer = null;
    // Stage changes from the last import are still forwarded as run.stage by the listener
    if (this.jsonl !== null && fs.existsSync(this.jsonl)) ingestFile(this.db, this.jsonl);
    this.rubricArtifacts?.record();
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.sessionWatcher?.close();
    this.sessionWatcher = null;
    this.update({
      crossRunRefs: scanCrossRunRefs(this.db, this.runId),
      sourceRefs: scanSourceRefs(this.db, this.runId),
    });
    await recordFriction(this.db, this.runId, this.row().sessionId);
    if (this.stage.prepare.includes('repo-copy')) {
      recordAcceptanceReport(this.db, this.runId, this.row().sessionId);
      await this.pollPr();
    }
    this.updateCost();
  }

  // On failure: end the subprocess and the watchers
  private async abort() {
    if (this.prTimer !== null) clearInterval(this.prTimer);
    this.unsubscribe?.();
    await this.sessionWatcher?.close();
    const proc = this.proc;
    if (proc !== null) {
      this.ending ??= 'cancel';
      proc.closeStdin();
      if ((await Promise.race([proc.exited, timeout(5_000)])) === 'timeout') proc.terminate();
      await proc.exited;
    }
  }

  private cleanup() {
    this.setPending(null);
  }

  // Server shutdown: end the claude subprocess and grading subprocesses, the run fails; a run in prepare stops after its
  // current step (create repo, clone) and never starts claude. Waits for drive to end fully, leaving no subprocess
  async shutdown() {
    this.shuttingDown = true;
    this.stopping.abort(new Error('Server shut down, run interrupted'));
    this.gradingAbort.abort(new Error('Server shut down, grading interrupted'));
    this.proc?.terminate();
    await this.done;
  }
}
