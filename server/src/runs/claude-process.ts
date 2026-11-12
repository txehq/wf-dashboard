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
  // The variant's --model, --effort, --mcp-config
  variantArgs: string[];
  sandboxProfile: string;
  // events.jsonl (every stdin and stdout message) and claude.stderr.log are written here
  logDir: string;
  onEvent: (event: StreamEvent) => void;
  onTurn: (transition: TurnTransition) => void;
  // Fatal errors such as unparsable stdout; the run records them as failed
  onError: (error: Error) => void;
}

export interface Exit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

// Launch arguments from System Design section 7
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

// Long-lived claude -p stream-json subprocess wrapped in sandbox-exec: JSON lines on stdin, events parsed line by line from stdout
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
    // sandbox-exec execs claude, so the child pid is claude
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
    // EPIPE: the child closed stdin or is exiting, and exited reports the exit; other write errors fail the run (the answer was not delivered)
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
    // After unparsable output, later lines are ignored: the run has failed and must not answer control_request any more
    if (this.broken || line.trim() === '') return;
    let event: StreamEvent;
    try {
      event = parseStreamEvent(JSON.parse(line));
    } catch (error) {
      // Unparsable output fails the whole run, with the raw line in the error message
      this.broken = true;
      this.opts.onError(
        new Error(`Cannot parse claude stdout: ${line.slice(0, 500)}`, { cause: error }),
      );
      return;
    }
    // Thinking progress events are numerous; neither logged nor forwarded
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
    if (this.stdinClosed) throw new Error('stdin is closed, cannot write');
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

  // Answers control_request.can_use_tool: allow carries updatedInput, deny carries message
  respond(requestId: string, response: Record<string, unknown>) {
    this.write({
      type: 'control_response',
      response: { subtype: 'success', request_id: requestId, response },
    });
    this.tracker.controlAnswered(requestId);
  }

  // interrupt control message; returns once the CLI sends control_response
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
