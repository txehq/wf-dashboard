import fs from 'node:fs';
import { and, eq, sql } from 'drizzle-orm';
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
import {
  type AgentPrompt,
  type EvalFacts,
  type SimulatedPersona,
  simulateUser,
  type TranscriptEntry,
} from '../runs/simulated-user.js';
import { AskUserQuestionInput } from '../runs/stream.js';
import { answerMenu, pasted } from './keys.js';
import type { LivePty } from './pty.js';
import type { LiveWaiting } from './views.js';

// Claude Code hook 的 stdin（实测字段，Reports/W30 第一步）；其余字段原样记入 live_events
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

// 驾驶者变为人的原因
export type HandBackReason = 'input' | 'done' | 'max-turns' | 'error' | 'manual';

// 粘贴的文字与提交它的回车分开写入
const SUBMIT_GAP_MS = 300;
// PreToolUse hook 在问题菜单出现之前触发；读屏幕前至少等这么久
const MENU_SETTLE_MS = 1000;

// 鼠标上报（SGR 1006）与焦点事件不是按键：xterm.js 在鼠标移过终端、切换标签页时发送，不算接管
const ESC = String.fromCharCode(27);
const NON_KEY_INPUT = new RegExp(`^(?:${ESC}\\[<\\d+;\\d+;\\d+[Mm]|${ESC}\\[[IO])+$`, 'u');
export const isKeyInput = (data: string) => !NON_KEY_INPUT.test(data);

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

export interface LiveControllerOptions {
  db: Db;
  settings: SettingsStore;
  liveId: string;
  // 这次运行（live_processes 的一行）
  processId: number;
  pty: LivePty;
  // claude 写 session 的 jsonl
  jsonl: string;
  // 收到第一个 SessionStart 之后的驾驶者
  initialDriver: LiveDriver;
  persona: SimulatedPersona;
  eval: EvalFacts | null;
  // 交互所用的 variant（本机配置为空）；session 导入后绑定到它（Contracts 15.1）
  variantId: string | null;
  // variant 的数据目录，绑定模块读 skill 用
  dataDir: string;
  // 进程的工作目录：本机配置出现信任确认时记进 trust 事件
  cwd: string;
}

// Claude Code 询问是否信任工作目录的一屏（Reports/W30、W39 实测）
const TRUST_PROMPT = 'Is this a project you created or one you trust?';
const TRUST_YES = /❯.*Yes, I trust this folder/u;
const TRUST_POLL_MS = 200;

// 一个运行中的交互 session：hook 驱动的状态、模拟用户驾驶与接管（Contracts 14.4）
export class LiveController {
  private readonly db: Db;
  readonly liveId: string;
  readonly processId: number;
  readonly pty: LivePty;
  private jsonl: string;
  private watcher: SessionWatcher;
  private started = false;
  // 已经绑定到 variant 的 session
  private readonly bound = new Set<string>();
  waiting: LiveWaiting | null = null;
  private waitingSince = 0;
  // 正在生成或正在写按键的模拟回答；驾驶者变为人时中止
  private generation: { abort: AbortController; waiting: LiveWaiting } | null = null;
  readonly exited: Promise<void>;

  constructor(private readonly opts: LiveControllerOptions) {
    this.db = opts.db;
    this.liveId = opts.liveId;
    this.processId = opts.processId;
    this.pty = opts.pty;
    this.jsonl = opts.jsonl;
    this.watcher = watchSession(this.db, this.jsonl, (error) => {
      this.recordError(error);
    });
    this.bindImported();
    const stopBinding = events.subscribe((event) => {
      if (event.type === 'session.updated') this.bindImported();
    });
    const stopTrust = opts.variantId === null ? this.answerTrust() : () => undefined;
    this.exited = this.pty.exited.then(async (exit) => {
      stopBinding();
      stopTrust();
      this.generation?.abort.abort(new Error('进程已退出'));
      await this.watcher.close();
      if (fs.existsSync(this.jsonl)) ingestFile(this.db, this.jsonl);
      // 进程很快结束时，session 第一次导入发生在上面这次：同样绑定到这次所用的 variant
      this.bindImported();
      const endedAt = new Date();
      this.db
        .update(liveProcesses)
        .set({ status: 'exited', exitCode: exit.exitCode, endedAt })
        .where(eq(liveProcesses.id, this.processId))
        .run();
      this.db
        .update(liveSessions)
        .set({ updatedAt: endedAt })
        .where(eq(liveSessions.id, this.liveId))
        .run();
      this.event('exit', { exitCode: exit.exitCode, signal: exit.signal });
    });
  }

  get starting(): boolean {
    return !this.started;
  }

  // "本机配置"的信任确认（Contracts 14.2）：不改用户的 ~/.claude.json；第一个 SessionStart 之前，屏幕副本上出现
  // 信任确认时把光标移到"Yes, I trust this folder"并回车，之后由 Claude Code 自己记录信任。返回停止监视的函数
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
        // 回答时屏幕副本上的确认一并记下
        this.event('trust', { cwd: this.opts.cwd, screen: lines.filter((l) => l.trim() !== '') });
        return;
      }
      // 光标在别的选项上（默认是"No, exit"）：下移一行，下一次检查时再看
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

  // 交互的 session 第一次导入后绑定到交互所用的 variant；本机配置不绑定。/clear 换了 session 时新的 session 同样绑定
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
    const row = this.db
      .select({ driver: liveProcesses.driver })
      .from(liveProcesses)
      .where(eq(liveProcesses.id, this.processId))
      .get();
    if (row === undefined)
      throw new Error(`交互 ${this.liveId} 的进程 ${String(this.processId)} 不存在`);
    return row.driver;
  }

  private event(kind: LiveEventKind, payload: Record<string, unknown>) {
    this.db
      .insert(liveEvents)
      .values({ liveId: this.liveId, processId: this.processId, at: new Date(), kind, payload })
      .run();
    events.publish({ type: 'live.updated', liveId: this.liveId });
  }

  // 模拟用户与导入的错误：写进这个进程的 error，交给人，进程照常运行
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
    if (driver === 'human') {
      this.generation?.abort.abort(new Error('驾驶者变为人'));
      this.generation = null;
    }
    this.db.update(liveProcesses).set({ driver }).where(eq(liveProcesses.id, this.processId)).run();
    this.event('driver', { driver, reason });
    if (driver === 'simulated') this.respond();
  }

  // "交还"：驾驶者变为模拟用户；Claude Code 在等输入时立即回答
  release() {
    if (this.starting) throw new Error('启动中，收到 SessionStart 之前驾驶者固定为人');
    const waiting = this.waiting;
    // 人已经在终端里回答了的 AskUserQuestion 不再等待
    if (waiting?.kind === 'questions' && this.questionAnswered(waiting.toolUseId)) {
      this.waiting = null;
    }
    this.setDriver('simulated', 'release');
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
    if (row === undefined) throw new Error(`交互 ${this.liveId} 不存在`);
    // Claude Code 的项建出时就有 session id；只有 Codex 草稿的项会暂时为空
    if (row.id === null) throw new Error(`交互 ${this.liveId} 没有 session id`);
    return row.id;
  }

  // 客户端的输入：按键使模拟用户驾驶变为人，正在生成的回答被取消；这次按键照常写入
  input(data: string) {
    if (this.driver === 'simulated' && isKeyInput(data)) this.setDriver('human', 'input');
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
        // 后台任务还在运行时 Claude Code 会自己开始下一轮，不等用户（Spikes/Claude CLI 第 8 节）
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
    this.respond();
  }

  private onSessionStart(payload: HookPayload) {
    // /clear 等操作换了 session：之后导入新的 jsonl
    if (payload.session_id !== this.sessionId()) {
      const transcript = z.string().parse(payload.transcript_path);
      this.db
        .update(liveSessions)
        .set({ claudeSessionId: payload.session_id })
        .where(eq(liveSessions.id, this.liveId))
        .run();
      void this.watcher.close();
      this.jsonl = transcript;
      this.watcher = watchSession(this.db, this.jsonl, (error) => {
        this.recordError(error);
      });
    }
    // resume 的 session 启动后停在输入框，等用户接着上一轮回答
    if (payload.source === 'resume') this.setWaiting(this.lastAgentTurn());
    if (!this.started) {
      this.started = true;
      if (this.opts.initialDriver === 'simulated') this.setDriver('simulated', 'start');
      else events.publish({ type: 'live.updated', liveId: this.liveId });
    }
  }

  private lastAgentTurn(): LiveWaiting | null {
    if (fs.existsSync(this.jsonl)) ingestFile(this.db, this.jsonl);
    const items = sessionConversation(this.db, this.sessionId()) ?? [];
    const last = items.findLast((item) => item.kind !== 'notice');
    return last?.kind === 'agent' ? { kind: 'text', text: last.text } : null;
  }

  private setWaiting(waiting: LiveWaiting | null) {
    this.waiting = waiting;
    this.waitingSince = Date.now();
    // 之前的提问已经过去，正在生成的回答作废
    this.generation?.abort.abort(new Error('Claude Code 已不在等这次回答'));
    this.generation = null;
    events.publish({ type: 'live.updated', liveId: this.liveId });
  }

  // 对话记录（Contracts 第 11 节）：最新一轮的文字或这次提问由 prompt 单独给出
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

  private answeredCount(): number {
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(liveEvents)
        .where(
          and(
            eq(liveEvents.liveId, this.liveId),
            eq(liveEvents.kind, 'simulated_reply'),
            sql`json_extract(${liveEvents.payload}, '$.written') = 1`,
          ),
        )
        .get()?.n ?? 0
    );
  }

  private respond() {
    const waiting = this.waiting;
    if (
      !this.started ||
      waiting === null ||
      this.generation !== null ||
      !this.pty.alive ||
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
        // 驾驶者变为人或 Claude Code 不再等待时中止，回答作废
        if (abort.signal.aborted) {
          const reason: unknown = abort.signal.reason;
          this.event('simulated_reply', {
            written: false,
            discarded: reason instanceof Error ? reason.message : String(reason),
          });
          return;
        }
        this.recordError(error instanceof Error ? error : new Error(String(error)));
      },
    );
  }

  private async simulate(waiting: LiveWaiting, abort: AbortController) {
    const prompt: AgentPrompt =
      waiting.kind === 'text'
        ? { kind: 'text', text: waiting.text }
        : { kind: 'questions', questions: waiting.questions };
    const reply = await simulateUser(
      { task: this.opts.persona, eval: this.opts.eval, signal: abort.signal },
      this.transcript(waiting),
      prompt,
    );
    abort.signal.throwIfAborted();
    const record = {
      prompt: waiting.kind,
      ...(waiting.kind === 'questions' ? { questions: waiting.questions } : {}),
      reply: reply.reply,
      answers: reply.answers ?? null,
      done: reply.done,
      costUsd: reply.costUsd,
      model: reply.model,
    };
    if (reply.done) {
      this.event('simulated_reply', { ...record, written: false });
      this.setDriver('human', 'done');
      return;
    }
    if (waiting.kind === 'text') {
      this.pty.write(pasted(reply.reply));
      await sleep(SUBMIT_GAP_MS);
      abort.signal.throwIfAborted();
      this.pty.write('\r');
    } else {
      const wait = this.waitingSince + MENU_SETTLE_MS - Date.now();
      if (wait > 0) await sleep(wait);
      const selections = reply.selections;
      if (selections === undefined)
        throw new Error('模拟用户回答 AskUserQuestion 没有给出选项编号');
      await answerMenu(this.pty, waiting.questions, selections, abort.signal);
    }
    if (this.waiting === waiting) this.waiting = null;
    this.event('simulated_reply', { ...record, written: true });
  }

  // 服务关闭：结束进程并等它退出
  async shutdown() {
    this.generation?.abort.abort(new Error('服务关闭'));
    this.pty.kill('SIGHUP');
    await this.exited;
  }
}
