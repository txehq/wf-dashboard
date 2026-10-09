import fs from 'node:fs';
import path from 'node:path';
import type { FSWatcher } from 'chokidar';
import { eq } from 'drizzle-orm';
import { execa } from 'execa';
import { runCostBreakdown } from '../cost.js';
import type { Db } from '../db/index.js';
import { type AskQuestion, type RunStatus, runs } from '../db/schema.js';
import { events } from '../events.js';
import { createEmptyRunRepo, createRunRepo, readPr } from '../external/github.js';
import { createRunTicket } from '../external/linear.js';
import { gradeRun } from '../grading/index.js';
import { ingestFile } from '../ingest/ingest.js';
import { watchSession } from '../ingest/watch.js';
import { featureDir } from '../stages/lfg.js';
import { loadTask } from '../tasks/loader.js';
import type { Task } from '../tasks/schema.js';
import { HttpError } from '../variants/errors.js';
import type { Variants } from '../variants/index.js';
import { ClaudeProcess } from './claude-process.js';
import { IcLiveStages, LfgLiveStages, type LiveStages } from './live-stages.js';
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
}

// 取消与结束时等待 CLI 收尾的时间；超时后发 SIGTERM（Spikes/Claude CLI 第 7 节）
const SETTLE_TIMEOUT_MS = 60_000;
const PR_POLL_MS = 60_000;
const DENY_MESSAGE = '评估环境不允许这个操作，请换一种方式继续。';

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
        `${q.header ? `[${q.header}] ` : ''}${q.question}${q.multiSelect ? '（可多选）' : ''}`,
        ...q.options.map((o) => `- ${o.label}${o.description ? `：${o.description}` : ''}`),
      ].join('\n'),
    )
    .join('\n\n');
}

const formatAnswers = (answers: Record<string, string>) =>
  Object.entries(answers)
    .map(([q, a]) => `${q} → ${a}`)
    .join('\n');

// 一个 run 的完整生命周期：准备、驱动 claude 子进程与模拟用户、接管、结束与评分
export class RunDriver {
  mode: RunMode = 'simulated';
  pending: Pending | null = null;
  readonly done: Promise<void>;

  private readonly db: Db;
  private task!: Task;
  private proc: ClaudeProcess | null = null;
  private stages: LiveStages | null = null;
  private sessionWatcher: FSWatcher | null = null;
  private unsubscribe: (() => void) | null = null;
  private prTimer: NodeJS.Timeout | null = null;
  private prPolling = false;
  private jsonl: string | null = null;
  // 上一次回答之后主 session 的全部回复文字：提问可能出现在 tool 调用或后台任务之前
  private turnText: string[] = [];
  // pending 对应的 agent 消息 seq；模拟用户的对话记录截止到它之前
  private pendingSeq = -1;
  private readonly questionInputs = new Map<string, Record<string, unknown>>();
  private simulating = false;
  private ending: 'finish' | 'cancel' | null = null;
  private shuttingDown = false;
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
    // drive 中途若没有 await failed，拒绝也不能成为未处理的 Promise
    this.failed.catch(() => undefined);
    this.done = this.drive().then(
      () => {
        this.cleanup();
      },
      async (error: unknown) => {
        const err = error instanceof Error ? error : new Error(String(error));
        console.error(`[run ${runId}] 失败`, err);
        await this.abort();
        this.setStatus('failed', { error: err.message, endedAt: new Date() });
        this.cleanup();
      },
    );
  }

  // 回调中的错误（stdout 解析、模拟用户、阶段判定）都让 run 失败
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
    if (row === undefined) throw new Error(`run ${this.runId} 不存在`);
    return row;
  }

  private update(values: Partial<RunRow>) {
    this.db.update(runs).set(values).where(eq(runs.id, this.runId)).run();
  }

  private setStatus(status: RunStatus, values: Partial<RunRow> = {}) {
    this.update({ ...values, status });
    events.publish({ type: 'run.status', runId: this.runId, status });
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

  private productDir() {
    return path.join(this.deps.vaultDir, `Project ${this.deps.product}`);
  }

  private async drive() {
    const run = this.row();
    this.task = loadTask(this.db, run.taskId);
    this.setStatus('preparing', { startedAt: new Date() });
    const initial = await this.prepare(run);
    await this.start(run, initial);
    const proc = this.proc;
    if (proc === null) throw new Error('claude 进程没有启动');
    const exit = await Promise.race([proc.exited, this.failed]);
    if (this.shuttingDown) throw new Error('服务关闭，运行中断');
    await this.teardown();
    if (this.ending === 'cancel') {
      this.setStatus('cancelled', { endedAt: new Date() });
      return;
    }
    if (this.ending !== 'finish') {
      throw new Error(
        `claude 进程意外退出（code=${String(exit.code)}，signal=${String(exit.signal)}）`,
      );
    }
    this.setStatus('grading');
    await Promise.race([gradeRun(this.db, this.runId), this.failed]);
    this.updateCost();
    this.setStatus('succeeded', { endedAt: new Date() });
  }

  // Contracts 7.2：外部对象、workspace 与 vault；返回初始消息
  private async prepare(run: RunRow): Promise<string> {
    fs.mkdirSync(this.runDir(), { recursive: true });
    const task = this.task;
    let repo: string;
    let initial: string;
    if (task.kind === 'lfg') {
      const created = await createEmptyRunRepo(this.runId);
      repo = created.repo;
      this.update({ githubRepo: repo });
      upsertArtifact(this.db, this.runId, 'repo', created.url, null);
      // wf obsidian 要求 product 目录已存在
      fs.mkdirSync(this.productDir(), { recursive: true });
      initial = [
        `/lfg ${task.input}`,
        '',
        `Product: ${this.deps.product}`,
        `Feature slug: ${this.runId}`,
        `Repository: ${repo}`,
      ].join('\n');
    } else {
      const created = await createRunRepo(task, this.runId);
      repo = created.repo;
      this.update({ githubRepo: repo });
      upsertArtifact(this.db, this.runId, 'repo', created.url, null);
      const ticket = await createRunTicket(task, this.runId);
      this.update({ linearIssueId: ticket.uuid, linearIssueIdentifier: ticket.identifier });
      upsertArtifact(this.db, this.runId, 'ticket', ticket.url, ticket.identifier);
      initial = `/ic ${ticket.identifier}`;
    }
    await execa('gh', ['repo', 'clone', repo, run.workspacePath]);
    return initial;
  }

  private simulatedUserContext(): SimulatedUserContext {
    const run = this.row();
    if (run.githubRepo === null) throw new Error(`run ${this.runId} 没有仓库`);
    return {
      task: this.task,
      runId: this.runId,
      repo: run.githubRepo,
      ticket: run.linearIssueIdentifier,
      product: this.deps.product,
    };
  }

  private async start(run: RunRow, initial: string) {
    if (this.shuttingDown) throw new Error('服务关闭，运行中断');
    const runtime = this.deps.variants.runtimeEnv(run.variantId);
    const env: Record<string, string> = {
      ...runtime.env,
      // jsonl 固定写到 <CLAUDE_CONFIG_DIR>/projects/<runId>/<sessionId>.jsonl
      CLAUDE_CODE_PROJECT_DIR_NAME: this.runId,
      MAGI_VAULT: this.deps.vaultDir,
      ...(this.task.kind === 'lfg' ? { MAGI_PRODUCT: this.deps.product } : {}),
    };
    const jsonl = path.join(
      runtime.env.CLAUDE_CONFIG_DIR,
      'projects',
      this.runId,
      `${run.sessionId}.jsonl`,
    );
    this.jsonl = jsonl;
    this.sessionWatcher = await watchSession(this.db, jsonl);

    const stageOptions = {
      db: this.db,
      runId: this.runId,
      sessionId: run.sessionId,
      workflow: this.task.kind,
      ingest: () => {
        if (fs.existsSync(jsonl)) ingestFile(this.db, jsonl);
      },
      onError: this.fail,
    };
    if (this.task.kind === 'lfg') {
      const stages = new LfgLiveStages(
        stageOptions,
        this.productDir(),
        featureDir(this.deps.vaultDir, this.deps.product, this.runId),
      );
      await stages.start();
      this.stages = stages;
    } else {
      this.stages = new IcLiveStages(stageOptions);
      this.prTimer = setInterval(() => {
        this.guard(this.pollPr());
      }, PR_POLL_MS);
    }
    this.unsubscribe = events.subscribe((event) => {
      if (event.type === 'session.updated' && event.sessionId === run.sessionId) {
        this.stages?.onSessionUpdated();
      }
    });

    this.proc = new ClaudeProcess({
      sessionId: run.sessionId,
      cwd: run.workspacePath,
      env,
      variantArgs: runtime.claudeArgs,
      sandboxProfile: runtime.sandboxProfile,
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
    await this.stages?.onTurnEnd();
    this.updateCost();
    if (this.task.kind === 'ic') await this.pollPr();
  }

  private onControlRequest(event: ControlRequestEvent) {
    const proc = this.proc;
    if (proc === null) throw new Error('claude 进程尚未启动就收到 control_request');
    const { request } = event;
    if (request.subtype !== 'can_use_tool') {
      this.fail(new Error(`无法处理的 control_request：${JSON.stringify(request)}`));
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
    // 其余权限请求（只会是关键路径删除这类安全检查）一律拒绝并记录
    proc.respond(event.request_id, { behavior: 'deny', message: DENY_MESSAGE });
    const toolName = request.tool_name ?? '(未知)';
    addMessage(this.db, this.runId, {
      role: 'system',
      content: `拒绝了 ${toolName} 的权限请求${request.decision_reason ? `：${request.decision_reason}` : ''}`,
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
      throw new Error(`模拟用户回答次数达到上限 ${String(max)}，对话没有结束`);
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
      // 生成期间被接管或结束：回答作废，花费照常记入
      addMessage(this.db, this.runId, {
        role: 'system',
        content: `模拟用户的回答未发送（${this.ending === null ? '已被接管' : '运行正在结束'}）：${reply.reply}`,
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
    if (proc === null) throw new Error('claude 进程尚未启动');
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
    if (answers === undefined) throw new Error('回答 AskUserQuestion 需要 answers');
    const input = this.questionInputs.get(pending.requestId);
    if (input === undefined) throw new Error(`没有 control_request ${pending.requestId} 的 input`);
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

  // 未回答的 AskUserQuestion 在结束与取消时拒绝，让 CLI 收尾
  private denyPendingQuestion() {
    const pending = this.pending;
    if (pending?.kind !== 'questions' || this.proc === null) return;
    this.questionInputs.delete(pending.requestId);
    this.proc.respond(pending.requestId, { behavior: 'deny', message: '运行已结束。' });
    this.setPending(null);
  }

  // 关闭 stdin：CLI 处理完当前一轮与后台任务后退出，随后进入 grading
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
      throw new HttpError(409, `run ${this.runId} 不在运行中`);
    }
    if (this.ending !== null) throw new HttpError(409, `run ${this.runId} 正在结束`);
  }

  takeover() {
    this.requireRunning();
    this.mode = 'human';
    this.update({ humanIntervened: true });
    addMessage(this.db, this.runId, {
      role: 'system',
      content: '页面接管了对话',
      payload: { kind: 'event', event: 'takeover' },
    });
    events.publish({ type: 'run.pending', runId: this.runId, pending: this.pending });
  }

  release() {
    this.requireRunning();
    if (this.mode !== 'human') throw new HttpError(409, `run ${this.runId} 没有被接管`);
    this.mode = 'simulated';
    addMessage(this.db, this.runId, {
      role: 'system',
      content: '对话交还给模拟用户',
      payload: { kind: 'event', event: 'release' },
    });
    this.respondIfSimulated();
  }

  private requireHuman() {
    this.requireRunning();
    if (this.mode !== 'human') throw new HttpError(409, `run ${this.runId} 没有被接管`);
  }

  reply(text: string) {
    this.requireHuman();
    const pending = this.pending;
    if (pending?.kind !== 'text') throw new HttpError(409, '当前没有待回答的文字提问');
    this.deliver(pending, { reply: text, done: false, costUsd: 0 }, 'human');
  }

  answer(answers: Record<string, string>) {
    this.requireHuman();
    const pending = this.pending;
    if (pending?.kind !== 'questions') throw new HttpError(409, '当前没有待回答的 AskUserQuestion');
    const expected = pending.questions.map((q) => q.question).sort();
    if (JSON.stringify(Object.keys(answers).sort()) !== JSON.stringify(expected)) {
      throw new HttpError(400, `answers 的键必须是全部问题：${JSON.stringify(expected)}`);
    }
    this.deliver(pending, { reply: '', answers, done: false, costUsd: 0 }, 'human');
  }

  finish() {
    this.requireHuman();
    addMessage(this.db, this.runId, {
      role: 'system',
      content: '页面结束了运行',
      payload: { kind: 'event', event: 'finish' },
    });
    this.finishProcess();
  }

  // interrupt 控制消息 → 等 result → 关闭 stdin；超时则 SIGTERM
  async cancel() {
    this.requireRunning();
    const proc = this.proc;
    if (proc === null) throw new Error('claude 进程尚未启动');
    this.ending = 'cancel';
    addMessage(this.db, this.runId, {
      role: 'system',
      content: '页面取消了运行',
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
    const { total } = runCostBreakdown(this.db, this.runId);
    if (total === this.row().costUsd) return;
    this.update({ costUsd: total });
    events.publish({ type: 'run.cost', runId: this.runId, costUsd: total });
  }

  // 进程退出后：最后一次读入 jsonl 与阶段判定，停止监听
  private async teardown() {
    if (this.prTimer !== null) clearInterval(this.prTimer);
    this.prTimer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.jsonl !== null && fs.existsSync(this.jsonl)) ingestFile(this.db, this.jsonl);
    await Promise.race([this.stages?.close(), this.failed]);
    await this.sessionWatcher?.close();
    this.sessionWatcher = null;
    if (this.task.kind === 'ic') await this.pollPr();
    this.updateCost();
  }

  // 失败时结束子进程与监听；不再做阶段判定
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

  // 服务关闭：结束 claude 子进程，run 记为失败；准备阶段的 run 由下次启动时的状态修正处理
  async shutdown() {
    this.shuttingDown = true;
    const proc = this.proc;
    if (proc === null) return;
    proc.terminate();
    await this.done;
  }
}
