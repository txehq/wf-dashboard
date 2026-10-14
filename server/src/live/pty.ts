import fs from 'node:fs';
import xtermHeadless from '@xterm/headless';
import * as pty from 'node-pty';

// 每个 session 在内存中保留的输出上限（Contracts 14.3）；完整输出另写 pty.log
export const RETAINED_BYTES = 4 * 1024 * 1024;

// pty.log 的最后 RETAINED_BYTES 字节；截断时从下一个换行开始，不从一个字符或一段控制序列中间开始
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

export interface PtyExit {
  exitCode: number;
  signal: number | null;
}

export interface LivePtyOptions {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  // 一项的全部进程共用的 pty.log（Contracts 14.5）：跨进程追加
  logFile: string;
  // 进程开始时写进 pty.log 与保留的输出的一行分隔（时间、start 或 resume、variant）
  separator: string;
}

// 还没有释放保留的输出与屏幕副本的 PTY（GET /api/diagnostics 的 live.ptys）
const unreleased = new Set<LivePty>();
export function unreleasedPtys(): { unreleased: number; retainedBytes: number } {
  let retainedBytes = 0;
  for (const p of unreleased) retainedBytes += p.retainedBytesCount;
  return { unreleased: unreleased.size, retainedBytes };
}

// 一个交互进程的 PTY：保留这一项最近的输出（之前进程的输出加这个进程的输出）供新连接的客户端回放，
// 完整输出追加到 pty.log
export class LivePty {
  readonly pid: number;
  readonly exited: Promise<PtyExit>;
  private readonly proc: pty.IPty;
  private readonly log: fs.WriteStream;
  private retained: Buffer[] = [];
  private retainedBytes = 0;
  private readonly listeners = new Set<(data: string) => void>();
  private exit: PtyExit | null = null;
  // 屏幕副本：模拟用户回答选项菜单前读取光标所在行与勾选状态
  private readonly screen: xtermHeadless.Terminal;
  private screenDisposed = false;

  constructor(opts: LivePtyOptions) {
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
    this.proc = pty.spawn(opts.file, opts.args, {
      name: 'xterm-256color',
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: opts.env,
    });
    this.pid = this.proc.pid;
    unreleased.add(this);
    this.proc.onData((data) => {
      this.retain(data);
      this.log.write(data);
      this.screen.write(data);
      for (const listener of this.listeners) listener(data);
    });
    // 进程退出：pty.log 写完后 exited 才完成（之后连上的终端从 pty.log 回放完整的输出）；
    // 等 exited 的各方（controller 中止模拟回答、终端发 exit 并关闭连接）处理完的下一轮释放保留的输出与屏幕副本
    this.exited = new Promise((resolve) => {
      this.proc.onExit(({ exitCode, signal }) => {
        const exit = { exitCode, signal: signal ?? null };
        this.exit = exit;
        this.log.end(() => {
          resolve(exit);
          setImmediate(() => {
            void this.release();
          });
        });
      });
    });
  }

  // 释放之后留下的最后一屏（进程提前退出时报错要用，Codex 的 waitForSession）
  private finalScreen: string[] | null = null;

  private async release() {
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
    // 从最早的整块开始丢弃，不在一块输出中间截断
    while (this.retainedBytes > RETAINED_BYTES && this.retained.length > 1) {
      const dropped = this.retained.shift();
      if (dropped !== undefined) this.retainedBytes -= dropped.length;
    }
  }

  // 保留的输出：新连接的客户端先收到它
  backlog(): string {
    return Buffer.concat(this.retained).toString('utf8');
  }

  // GET /api/diagnostics：保留的输出的字节数，屏幕副本是否已释放
  get retainedBytesCount(): number {
    return this.retainedBytes;
  }

  get screenReleased(): boolean {
    return this.screenDisposed;
  }

  get alive(): boolean {
    return this.exit === null;
  }

  onData(listener: (data: string) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  write(data: string) {
    if (this.exit !== null) throw new Error(`进程 ${String(this.pid)} 已退出，不能再写入`);
    this.proc.write(data);
  }

  // 屏幕上当前可见的各行；进程退出、屏幕副本释放之后为最后一屏
  async viewport(): Promise<string[]> {
    return this.finalScreen ?? this.visibleLines();
  }

  // 写入是异步处理的，读取前先等已写入的输出处理完
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

  resize(cols: number, rows: number) {
    if (this.exit !== null) return;
    this.proc.resize(cols, rows);
    this.screen.resize(cols, rows);
  }

  kill(signal: NodeJS.Signals = 'SIGHUP') {
    if (this.exit !== null) return;
    this.proc.kill(signal);
  }
}
