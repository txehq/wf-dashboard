import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { isType, parseStreamEvent, type StreamEvent } from './stream.js';
import { type TurnTransition, TurnTracker } from './turn-tracker.js';

export interface ClaudeProcessOptions {
  sessionId: string;
  cwd: string;
  env: Record<string, string>;
  // variant 的 --model、--effort、--mcp-config
  variantArgs: string[];
  sandboxProfile: string;
  // events.jsonl（stdin 与 stdout 的全部消息）与 claude.stderr.log 写在这里
  logDir: string;
  onEvent: (event: StreamEvent) => void;
  onTurn: (transition: TurnTransition) => void;
  // stdout 无法解析等致命错误；由 run 记为失败
  onError: (error: Error) => void;
}

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

// System Design 第 7 节的启动参数
export function claudeArgs(sessionId: string, variantArgs: string[]): string[] {
  return [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--session-id',
    sessionId,
    ...variantArgs,
    '--permission-mode',
    'bypassPermissions',
    '--permission-prompt-tool',
    'stdio',
  ];
}

// 常驻的 claude -p stream-json 子进程，包在 sandbox-exec 中：stdin 写 JSON 行，stdout 逐行解析事件
export class ClaudeProcess {
  readonly tracker: TurnTracker;
  readonly exited: Promise<Exit>;
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly log: fs.WriteStream;
  private readonly controlWaiters = new Map<string, () => void>();
  private stdinClosed = false;
  private broken = false;

  constructor(private readonly opts: ClaudeProcessOptions) {
    fs.mkdirSync(opts.logDir, { recursive: true });
    this.log = fs.createWriteStream(path.join(opts.logDir, 'events.jsonl'), { flags: 'a' });
    this.tracker = new TurnTracker(opts.onTurn);
    const args = claudeArgs(opts.sessionId, opts.variantArgs);
    this.record('argv', ['claude', ...args]);
    // sandbox-exec 以 exec 方式启动 claude，子进程 pid 即 claude
    this.child = spawn('sandbox-exec', ['-p', opts.sandboxProfile, 'claude', ...args], {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stderr.pipe(
      fs.createWriteStream(path.join(opts.logDir, 'claude.stderr.log'), { flags: 'a' }),
    );
    this.exited = new Promise((resolve) => {
      this.child.on('exit', (code, signal) => {
        this.record('exit', { code, signal });
        resolve({ code, signal });
      });
    });
    this.child.on('error', (error) => {
      opts.onError(error);
    });
    // EPIPE：子进程已关闭 stdin 或正在退出，退出本身由 exited 报告；其余写入错误让 run 失败（回答没有送达）
    this.child.stdin.on('error', (error: NodeJS.ErrnoException) => {
      this.record('stdin-error', error.message);
      if (error.code !== 'EPIPE') opts.onError(error);
    });
    readline.createInterface({ input: this.child.stdout }).on('line', (line) => {
      this.onLine(line);
    });
  }

  get pid(): number | undefined {
    return this.child.pid;
  }

  private record(dir: string, event: unknown) {
    this.log.write(`${JSON.stringify({ t: Date.now(), dir, event })}\n`);
  }

  private onLine(line: string) {
    // 出现过无法解析的输出之后不再处理后续行：run 已经失败，不能再回答 control_request
    if (this.broken || line.trim() === '') return;
    let event: StreamEvent;
    try {
      event = parseStreamEvent(JSON.parse(line));
    } catch (error) {
      // 无法解析的输出让整个 run 失败，原始行写入错误信息
      this.broken = true;
      this.opts.onError(
        new Error(`claude stdout 无法解析：${line.slice(0, 500)}`, { cause: error }),
      );
      return;
    }
    // 思考进度事件数量很多，不写日志也不转发
    if (isType(event, 'system') && event.subtype === 'thinking_tokens') return;
    this.record('out', event);
    this.tracker.observe(event);
    if (isType(event, 'control_response')) {
      const waiter = this.controlWaiters.get(event.response.request_id);
      if (waiter !== undefined) {
        this.controlWaiters.delete(event.response.request_id);
        waiter();
      }
    }
    this.opts.onEvent(event);
  }

  private write(message: unknown) {
    if (this.stdinClosed) throw new Error('stdin 已关闭，不能再写入');
    this.record('in', message);
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  sendUser(text: string) {
    this.tracker.userSent();
    this.write({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text }] },
      parent_tool_use_id: null,
      session_id: '',
    });
  }

  // 回答 control_request.can_use_tool：allow 带 updatedInput，deny 带 message
  respond(requestId: string, response: Record<string, unknown>) {
    this.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    });
    this.tracker.controlAnswered(requestId);
  }

  // interrupt 控制消息；CLI 回 control_response 后返回
  interrupt(): Promise<void> {
    const requestId = `req_${randomUUID()}`;
    const answered = new Promise<void>((resolve) => this.controlWaiters.set(requestId, resolve));
    this.write({
      type: 'control_request',
      request_id: requestId,
      request: { subtype: 'interrupt' },
    });
    return answered;
  }

  closeStdin() {
    if (this.stdinClosed) return;
    this.stdinClosed = true;
    this.record('in', '<stdin closed>');
    this.child.stdin.end();
  }

  terminate() {
    this.record('signal', 'SIGTERM');
    this.child.kill('SIGTERM');
  }
}
