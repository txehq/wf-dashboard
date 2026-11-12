import fs from 'node:fs';
import { z } from 'zod';
import type { LiveTerminal, PtyExit } from '../live/pty.js';
import { type OrcaPlace, orcaCall } from './cli.js';

// Orca-managed terminals (Contracts 35.4): Orca's main agent and workers run in Orca terminals, whose raw output the dashboard cannot read.
// While a page is connected (onData has subscribers) the screen from orca terminal read --screen is read every second and drawn as one xterm
// frame for the page; no colours, no scrollback. Input is written as-is with orca terminal send (control characters included, no automatic Enter). The topology sync detects the process end and calls end()

const Screen = z.object({ terminal: z.object({ tail: z.array(z.string()) }) });

export interface OrcaPaneStop {
  // The two steps of "Stop process": orchestration worker-stop for a worker, two Ctrl+C to its terminal for Orca's main agent
  interrupt(): Promise<void>;
  forceStop(): Promise<void>;
}

export class OrcaPaneTerminal implements LiveTerminal {
  // The process is not owned by the dashboard: not ended when all pages close, keeps running on server shutdown
  readonly remote = true;
  readonly connected = true;
  readonly exited: Promise<PtyExit>;
  private finish: (exit: PtyExit) => void = () => undefined;
  private ended = false;
  private lines: string[] = [];
  private frame = '';
  private readonly listeners = new Set<(data: string) => void>();
  private timer: NodeJS.Timeout | null = null;
  private reading = false;
  // Input is written in order
  private sending: Promise<void> = Promise.resolve();

  constructor(
    private readonly opts: {
      place: OrcaPlace;
      handle: string;
      pid: number | null;
      pollMs: number;
      stop: OrcaPaneStop;
      logFile: string;
      // This process's separator line in pty.log
      separator: string;
      // Error from reading the screen or sending input (recorded in this process's error)
      onError: (error: Error) => void;
    },
  ) {
    this.exited = new Promise((resolve) => {
      this.finish = resolve;
    });
  }

  get pid(): number | null {
    return this.opts.pid;
  }

  get alive(): boolean {
    return !this.ended;
  }

  // The agent exited or the terminal closed: the last screen read goes into pty.log, which ended items replay
  end(exit: PtyExit) {
    if (this.ended) return;
    this.ended = true;
    this.stopPolling();
    this.listeners.clear();
    fs.appendFileSync(this.opts.logFile, `${this.opts.separator}${this.frame}`);
    this.finish(exit);
  }

  onConnection(): () => void {
    return () => undefined;
  }

  backlog(): string {
    return this.frame;
  }

  onData(listener: (data: string) => void): () => void {
    this.listeners.add(listener);
    if (this.timer === null && !this.ended) {
      void this.read();
      this.timer = setInterval(() => {
        void this.read();
      }, this.opts.pollMs);
    }
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.stopPolling();
    };
  }

  private stopPolling() {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  // Read one screen; send it to the page when it differs from the last frame. Skip while the previous read is still running
  private async read() {
    if (this.reading || this.ended) return;
    this.reading = true;
    const result = await orcaCall(this.opts.place, [
      'terminal',
      'read',
      '--terminal',
      this.opts.handle,
      '--screen',
    ]).then(
      (value) => Screen.parse(value).terminal.tail,
      (error: unknown) => {
        this.opts.onError(error instanceof Error ? error : new Error(String(error)));
        return null;
      },
    );
    this.reading = false;
    // The agent may have exited during the read
    if (result === null || !this.alive) return;
    this.lines = result;
    // Each frame clears the screen and scrollback before drawing: when the page has fewer rows than Orca's screen or long lines wrap, only the
    // top of this frame scrolls off and the bottom (with the prompt) stays visible; one write, so the page does not flicker
    const frame = `\u001b[H\u001b[2J\u001b[3J${result.join('\r\n')}`;
    if (frame === this.frame) return;
    this.frame = frame;
    for (const listener of this.listeners) listener(frame);
  }

  write(data: string) {
    this.sending = this.sending.then(async () => {
      if (this.ended) return;
      await orcaCall(this.opts.place, [
        'terminal',
        'send',
        '--terminal',
        this.opts.handle,
        `--text=${data}`,
      ]).then(
        () => undefined,
        (error: unknown) => {
          this.opts.onError(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  async viewport(): Promise<string[]> {
    if (this.timer === null) await this.read();
    return this.lines;
  }

  // Orca decides the terminal size; after the page resizes, redraw this frame so it wraps at the page's new size
  resize() {
    if (this.frame === '') return;
    for (const listener of this.listeners) listener(this.frame);
  }

  get cols(): number {
    return Math.max(80, ...this.lines.map((l) => l.length));
  }

  get retainedBytesCount(): number {
    return Buffer.byteLength(this.frame);
  }

  readonly screenReleased = false;

  interrupt(): Promise<void> {
    return this.opts.stop.interrupt();
  }

  forceStop(): Promise<void> {
    return this.opts.stop.forceStop();
  }

  // Server shutdown: only stop reading the screen; the process keeps running in Orca and exited does not resolve
  close(): Promise<void> {
    this.stopPolling();
    this.listeners.clear();
    return Promise.resolve();
  }
}
