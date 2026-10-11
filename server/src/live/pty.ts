import fs from 'node:fs';
import xtermHeadless from '@xterm/headless';
import * as pty from 'node-pty';

// 每个 session 在内存中保留的输出上限（Contracts 14.3）；完整输出另写 pty.log
const RETAINED_BYTES = 4 * 1024 * 1024;

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
  logFile: string;
}

// 一个交互 session 的 PTY：保留最近的输出供新连接的客户端回放，完整输出追加到 pty.log
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

  constructor(opts: LivePtyOptions) {
    this.log = fs.createWriteStream(opts.logFile, { flags: 'a' });
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
    this.proc.onData((data) => {
      this.retain(data);
      this.log.write(data);
      this.screen.write(data);
      for (const listener of this.listeners) listener(data);
    });
    this.exited = new Promise((resolve) => {
      this.proc.onExit(({ exitCode, signal }) => {
        this.exit = { exitCode, signal: signal ?? null };
        this.log.end();
        resolve(this.exit);
      });
    });
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

  // 屏幕上当前可见的各行（写入是异步处理的，读取前先等已写入的输出处理完）
  async viewport(): Promise<string[]> {
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
