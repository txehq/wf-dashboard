import fs from 'node:fs';
import xtermHeadless from '@xterm/headless';
import * as pty from 'node-pty';

// Output each session keeps in memory (Contracts 14.3); the full output also goes to pty.log
export const RETAINED_BYTES = 4 * 1024 * 1024;

// The last RETAINED_BYTES bytes of pty.log; when truncated, start after the next newline, never inside a character or control sequence
export function readLogTail(file: string): string {
  if (!fs.existsSync(file)) return '';
  const size = fs.statSync(file).size;
  const length = Math.min(size, RETAINED_BYTES);
  const buffer = Buffer.alloc(length);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, buffer, 0, length, size - length);
  fs.closeSync(fd);
  if (length === size) return buffer.toString('utf8');
  const newline = buffer.indexOf(0x0a);
  return newline < 0 ? '' : buffer.subarray(newline + 1).toString('utf8');
}

// How a process ended: exit code (null when a remote one was killed by kill-session without one), signal, and the reason when it failed before ending (remote start failure)
export interface PtyExit {
  exitCode: number | null;
  signal: number | null;
  error: string | null;
}

// The terminal of a live process: a local PTY (LivePty) or a connection to a tmux session on an SSH host (RemoteTerminal in remote/terminal.ts).
// The controller, Codex sessions and the terminal WebSocket go only through this interface
export interface LiveTerminal {
  // A remote process does not end with the local connection and is exempt from "auto-stop after all pages close" (Contracts 31.4)
  readonly remote: boolean;
  // Local process id (for remote, the current ssh connection's pid; null before connecting)
  readonly pid: number | null;
  // Resolves when the process ends (for remote, the tmux session ends) and pty.log is fully written
  readonly exited: Promise<PtyExit>;
  readonly alive: boolean;
  // Remote: whether the tmux session connection is up; always true locally
  readonly connected: boolean;
  // Connection changes (remote disconnects and reconnects); returns an unsubscribe function. Local terminals never change
  onConnection(listener: (connected: boolean) => void): () => void;
  backlog(): string;
  onData(listener: (data: string) => void): () => void;
  write(data: string): void;
  viewport(): Promise<string[]>;
  resize(cols: number, rows: number): void;
  readonly cols: number;
  readonly retainedBytesCount: number;
  readonly screenReleased: boolean;
  // The two steps of "Stop process" (Contracts 14.3, 31.4): SIGINT and SIGTERM locally; tmux send-keys C-c and kill-session remotely
  interrupt(): Promise<void>;
  forceStop(): Promise<void>;
  // Server shutdown: locally stop the process and wait for it; remotely only drop the local connection, the tmux session keeps running and exited does not resolve
  close(): Promise<void>;
}

// Terminals that have not yet released their retained output and screen copy (live.ptys in GET /api/diagnostics)
const unreleased = new Set<TerminalRecord>();
export function unreleasedPtys(): { unreleased: number; retainedBytes: number } {
  let retainedBytes = 0;
  for (const p of unreleased) retainedBytes += p.retainedBytesCount;
  return { unreleased: unreleased.size, retainedBytes };
}

// An item's terminal output: keeps the item's recent output (earlier processes plus this one) for replay to new clients, appends the full output to pty.log,
// and feeds the server-side screen copy (read by the simulated user answering option menus and by the trust prompt)
export class TerminalRecord {
  private readonly log: fs.WriteStream;
  private retained: Buffer[] = [];
  private retainedBytes = 0;
  private readonly listeners = new Set<(data: string) => void>();
  private readonly screen: xtermHeadless.Terminal;
  private screenDisposed = false;
  // The last screen kept after release (used in errors when the process exits early, Codex's waitForSession)
  private finalScreen: string[] | null = null;

  constructor(opts: { logFile: string; separator: string; cols: number; rows: number }) {
    const before = readLogTail(opts.logFile);
    if (before !== '') this.retain(before);
    this.log = fs.createWriteStream(opts.logFile, { flags: 'a' });
    this.retain(opts.separator);
    this.log.write(opts.separator);
    this.screen = new xtermHeadless.Terminal({
      cols: opts.cols,
      rows: opts.rows,
      allowProposedApi: true,
    });
    unreleased.add(this);
  }

  push(data: string) {
    this.retain(data);
    this.log.write(data);
    this.screen.write(data);
    for (const listener of this.listeners) listener(data);
  }

  // pty.log fully written
  endLog(): Promise<void> {
    return new Promise((resolve) => {
      this.log.end(() => {
        resolve();
      });
    });
  }

  // Release the retained output and screen copy; viewport then returns the last screen
  async release() {
    this.finalScreen = await this.visibleLines();
    this.screen.dispose();
    this.screenDisposed = true;
    this.retained = [];
    this.retainedBytes = 0;
    this.listeners.clear();
    unreleased.delete(this);
  }

  private retain(data: string) {
    const chunk = Buffer.from(data, 'utf8');
    this.retained.push(chunk);
    this.retainedBytes += chunk.length;
    // Drop whole chunks from the oldest, never cutting inside a chunk
    while (this.retainedBytes > RETAINED_BYTES && this.retained.length > 1) {
      const dropped = this.retained.shift();
      if (dropped !== undefined) this.retainedBytes -= dropped.length;
    }
  }

  backlog(): string {
    return Buffer.concat(this.retained).toString('utf8');
  }

  get retainedBytesCount(): number {
    return this.retainedBytes;
  }

  get screenReleased(): boolean {
    return this.screenDisposed;
  }

  onData(listener: (data: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  // Lines currently visible on screen; after release, the last screen
  async viewport(): Promise<string[]> {
    return this.finalScreen ?? this.visibleLines();
  }

  // Writes are processed asynchronously; wait for pending output before reading
  private async visibleLines(): Promise<string[]> {
    await new Promise<void>((resolve) => {
      this.screen.write('', resolve);
    });
    const buffer = this.screen.buffer.active;
    const lines: string[] = [];
    for (let i = buffer.viewportY; i < buffer.viewportY + this.screen.rows; i++) {
      lines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    }
    return lines;
  }

  get cols(): number {
    return this.screen.cols;
  }

  resizeScreen(cols: number, rows: number) {
    if (this.screenDisposed) return;
    this.screen.resize(cols, rows);
  }
}

export interface LivePtyOptions {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  // pty.log shared by all of an item's processes (Contracts 14.5): appended across processes
  logFile: string;
  // Separator line written to pty.log and the retained output when the process starts (time, start or resume, variant)
  separator: string;
}

// The tty.ReadStream node-pty uses to read the PTY fd on Unix (_socket in lib/unixTerminal.js, missing from the IPty type)
interface UnixPty {
  _socket: { destroyed: boolean };
}

// The PTY of a local live process
export class LivePty implements LiveTerminal {
  readonly remote = false;
  readonly connected = true;
  readonly pid: number;
  readonly exited: Promise<PtyExit>;
  private readonly proc: pty.IPty;
  private readonly record: TerminalRecord;
  private exit: PtyExit | null = null;

  constructor(opts: LivePtyOptions) {
    this.record = new TerminalRecord(opts);
    this.proc = pty.spawn(opts.file, opts.args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
    });
    this.pid = this.proc.pid;
    this.proc.onData((data) => {
      this.record.push(data);
    });
    // Process exit: exited resolves only after pty.log is written (terminals connecting later replay the full output from it);
    // the retained output and screen copy are released on the tick after everyone awaiting exited (controller aborting simulated answers, terminal sending exit and closing) is done
    this.exited = new Promise((resolve) => {
      this.proc.onExit(({ exitCode, signal }) => {
        const exit = { exitCode, signal: signal ?? null, error: null };
        this.exit = exit;
        void this.record.endLog().then(() => {
          resolve(exit);
          setImmediate(() => {
            void this.record.release();
          });
        });
      });
    });
  }

  backlog(): string {
    return this.record.backlog();
  }

  get retainedBytesCount(): number {
    return this.record.retainedBytesCount;
  }

  get screenReleased(): boolean {
    return this.record.screenReleased;
  }

  get alive(): boolean {
    return this.exit === null;
  }

  // The PTY fd is closed: on exit node-pty first reads EOF or EIO and destroys the fd's read stream (destroyed becomes true, the fd closes synchronously),
  // and only later come the close event (next libuv tick) and onExit (after the native waitpid returns). In between a resize ioctl gets EBADF
  // and the fd may already be reused by another file, so after closing there is no more resize or write
  private get closed(): boolean {
    return (this.proc as unknown as UnixPty)._socket.destroyed;
  }

  onData(listener: (data: string) => void): () => void {
    return this.record.onData(listener);
  }

  onConnection(): () => void {
    return () => undefined;
  }

  write(data: string) {
    if (this.exit !== null) {
      throw new Error(`Process ${String(this.pid)} has exited and cannot be written to`);
    }
    // PTY closed but onExit not yet arrived: the process can no longer read input, drop it as node-pty does
    if (this.closed) return;
    this.proc.write(data);
  }

  viewport(): Promise<string[]> {
    return this.record.viewport();
  }

  get cols(): number {
    return this.record.cols;
  }

  resize(cols: number, rows: number) {
    if (this.closed) return;
    this.proc.resize(cols, rows);
    this.record.resizeScreen(cols, rows);
  }

  // kill signals by pid, not fd: the process may outlive the closed PTY, so keep signalling until onExit
  kill(signal: NodeJS.Signals = 'SIGHUP') {
    if (this.exit !== null) return;
    this.proc.kill(signal);
  }

  interrupt(): Promise<void> {
    this.kill('SIGINT');
    return Promise.resolve();
  }

  forceStop(): Promise<void> {
    this.kill('SIGTERM');
    return Promise.resolve();
  }

  async close(): Promise<void> {
    this.kill('SIGHUP');
    await this.exited;
  }
}
