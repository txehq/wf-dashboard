import { execa } from 'execa';
import { quote } from 'shell-quote';
import * as pty from 'node-pty';
import { type LiveTerminal, type PtyExit, TerminalRecord } from '../live/pty.js';
import type { RemoteHost } from './hosts.js';
import { RemoteCommandError, SshConnectError, type SshResult, sshExec, sshOptions } from './ssh.js';

// The dashboard directory on the remote (Contracts 31.1): $HOME/.wf-dashboard/, the only directory the dashboard writes there. tmux runs
// its own server (socket and config both here) and never touches the user's own tmux
export function remoteRoot(host: RemoteHost) {
  const root = `${host.home}/.wf-dashboard`;
  return {
    root,
    socket: `${root}/tmux.sock`,
    conf: `${root}/tmux.conf`,
    live: (liveId: string) => `${root}/live/${liveId}`,
    // A variant's config directory on the remote (Contracts 31.5, synced and installed by W96)
    variant: (variantId: string) => `${root}/variants/${variantId}`,
  };
}

// Remote files of an item: run.sh runs claude or codex and writes the exit code; port is the remote port reverse-forwarded to the dashboard
// (shared by all items on a host, read by the hook)
export function remoteLive(host: RemoteHost, liveId: string) {
  const r = remoteRoot(host);
  const dir = r.live(liveId);
  return {
    ...r,
    dir,
    session: `wfd-${liveId}`,
    run: `${dir}/run.sh`,
    exit: `${dir}/exit`,
    port: `${dir}/port`,
    hooks: `${dir}/hooks.json`,
  };
}

// tmux config: status bar off; the pane stays after the process ends (remain-on-exit), pane-died closes the session (run.sh writes the exit code);
// Esc does not wait for more keys; no alternate screen (smcup, rmcup), so scrolled-off output goes to the page terminal's own scrollback, as for local interactions
export const TMUX_CONF = [
  'set -g status off',
  'set -g remain-on-exit on',
  "set-hook -g pane-died 'kill-session'",
  'set -s escape-time 0',
  'set -g history-limit 50000',
  'set -g mouse off',
  'set -g window-size latest',
  "set -g default-terminal 'screen-256color'",
  "set -ga terminal-overrides ',*:smcup@:rmcup@'",
  "set -as terminal-features ',xterm-256color:RGB'",
  '',
].join('\n');

export interface RemoteTerminalOptions {
  host: RemoteHost;
  liveId: string;
  logFile: string;
  separator: string;
  cols: number;
  rows: number;
  // The port the dashboard actually listens on: each connection reverse-forwards a remote port to it
  dashboardPort: () => number;
  // Remote preparation before the first connection (writing run.sh, hooks.json etc., W96 syncs the variant); log goes to the terminal. Null on reconnect (after a server restart)
  prepare: ((log: (line: string) => void) => Promise<void>) | null;
  reconnectMs: number;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// tmux exits with 1 reporting the session or its server is gone: the server is up without this session (can't find session; send-keys
// targets a pane, so with other sessions on the same server it reports can't find pane), or the server has exited
// (no server running: the socket file remains; error connecting … No such file or directory: the socket file is gone too).
// pane-died closes the session when the interactive process ends and the server exits with its last session, so any step may meet this.
export function tmuxGone(result: SshResult, socket: string): boolean {
  if (result.exitCode !== 1) return false;
  return result.stderr
    .split('\n')
    .some(
      (line) =>
        line.startsWith("can't find session:") ||
        line.startsWith("can't find pane:") ||
        line === `no server running on ${socket}` ||
        line === `error connecting to ${socket} (No such file or directory)`,
    );
}

const dim = (line: string) => `\u001b[2m${line}\u001b[0m\r\n`;
const red = (line: string) => `\u001b[31m${line.replaceAll('\n', '\r\n')}\u001b[0m\r\n`;

// Reverse forward from the remote to the dashboard (Contracts 31.4): one shared by all items on a host (its ControlMaster). The master
// treats the same -R 0:127.0.0.1:<port> as one forward: successive requests return the same remote port; with concurrent requests the later one gets 0 before the earlier one is assigned a port.
// Cancel accepts only the 0: form (cancelling by the assigned port reports port not forwarded), and one cancel closes the shared port (measured with OpenSSH 9.6, 10.5).
// So requests per host are queued and the forward is cancelled only when its last user is done. The forward disappears with the master, and the next request gets a new port
const reverseForwards = new Map<string, { users: Set<object>; queue: Promise<void> }>();

function reverseForwardSpec(dashboardPort: number) {
  return `0:127.0.0.1:${String(dashboardPort)}`;
}

// Run in this host's queue: returns task's result (failures go to the caller as well); the queue only orders
function inForwardQueue<T>(target: string, spec: string, task: (users: Set<object>) => Promise<T>) {
  const key = `${target} ${spec}`;
  const entry = reverseForwards.get(key) ?? { users: new Set<object>(), queue: Promise.resolve() };
  reverseForwards.set(key, entry);
  const run = entry.queue.then(() => task(entry.users));
  entry.queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

// Add (or reuse) this host's reverse forward and return the remote port; null when unreachable
export function acquireReverseForward(target: string, dashboardPort: number, user: object) {
  const spec = reverseForwardSpec(dashboardPort);
  return inForwardQueue(target, spec, async (users) => {
    const result = await execa(
      'ssh',
      [...sshOptions(target), '-O', 'forward', '-R', spec, target],
      { input: '', reject: false },
    );
    if (result.exitCode !== 0) return null;
    const port = Number(result.stdout.trim());
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`ssh -O forward returned no remote port: ${JSON.stringify(result.stdout)}`);
    }
    users.add(user);
    return port;
  });
}

// Stop using this host's reverse forward: the last user cancels it. Without a master the forward is gone anyway, so a failed cancel does no harm
export function releaseReverseForward(target: string, dashboardPort: number, user: object) {
  const spec = reverseForwardSpec(dashboardPort);
  return inForwardQueue(target, spec, async (users) => {
    users.delete(user);
    if (users.size > 0) return;
    await execa('ssh', [...sshOptions(target), '-O', 'cancel', '-R', spec, target], {
      input: '',
      reject: false,
    });
  });
}

// A remote interactive process (Contracts 31.4): runs in tmux session wfd-<liveId>; node-pty on this machine runs ssh -tt to it.
// On disconnect, page close or dashboard restart the tmux session keeps running and is reconnected later; exited completes when the session is gone (process ended)
export class RemoteTerminal implements LiveTerminal {
  readonly remote = true;
  readonly exited: Promise<PtyExit>;
  private resolveExit!: (exit: PtyExit) => void;
  private readonly record: TerminalRecord;
  private proc: pty.IPty | null = null;
  // Completes when this connection exits (while proc is set)
  private procEnded: Promise<void> = Promise.resolve();
  private exit: PtyExit | null = null;
  private detached = false;
  private isConnected = false;
  private cols_: number;
  private rows_: number;
  // The dashboard port forwarded to while using this host's shared reverse forward (cancelled by it when done)
  private forwarded: number | null = null;
  private readonly connectionListeners = new Set<(connected: boolean) => void>();
  private readonly paths: ReturnType<typeof remoteLive>;

  constructor(private readonly opts: RemoteTerminalOptions) {
    this.record = new TerminalRecord(opts);
    this.cols_ = opts.cols;
    this.rows_ = opts.rows;
    this.paths = remoteLive(opts.host, opts.liveId);
    this.exited = new Promise((resolve) => {
      this.resolveExit = resolve;
    });
    // An error while preparing or connecting (e.g. writing run.sh failed): written to the terminal as is, the process ends with this text as error
    void this.run().then(undefined, async (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      this.record.push(red(message));
      await this.finish({ exitCode: null, signal: null, error: message });
    });
  }

  private get target() {
    return this.opts.host.target;
  }

  private tmux(...args: string[]): string {
    return quote([
      this.opts.host.tool('tmux'),
      '-u',
      '-S',
      this.paths.socket,
      '-f',
      this.paths.conf,
      ...args,
    ]);
  }

  log(line: string) {
    this.record.push(dim(line));
  }

  private async run() {
    let first = this.opts.prepare !== null;
    let announced = false;
    if (first) {
      const started = Date.now();
      this.log(`Preparing on ${this.opts.host.label}…`);
      await this.opts.prepare?.((line) => {
        this.log(line);
      });
      this.log(`Prepared (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    }
    while (this.following()) {
      const state = first ? { kind: 'running' as const } : await this.sessionState();
      // The server shut down while waiting: do not connect
      if (!this.following()) break;
      if (state.kind === 'unreachable') {
        if (!announced) {
          this.record.push(
            red(
              `Cannot reach ${this.opts.host.label}: ${state.error}; the remote process keeps running in tmux, reconnecting in ${String(this.opts.reconnectMs / 1000)} s`,
            ),
          );
          announced = true;
        }
        await sleep(this.opts.reconnectMs);
        continue;
      }
      if (state.kind === 'gone') {
        await this.finish(await this.readExit());
        return;
      }
      const port = await this.forward();
      if (!this.following()) break;
      if (port === null) {
        await sleep(this.opts.reconnectMs);
        continue;
      }
      announced = false;
      await this.attach(first);
      first = false;
    }
  }

  // Still following the remote process (false after close on server shutdown and after the process ends)
  private following(): boolean {
    return !this.detached && this.exit === null;
  }

  // The session is running, gone (session or tmux server gone), or unreachable; other tmux errors fail with their output
  private async sessionState(): Promise<
    { kind: 'running' } | { kind: 'gone' } | { kind: 'unreachable'; error: string }
  > {
    const result = await sshExec(this.target, this.tmux('has-session', '-t', this.paths.session));
    if (result.exitCode === 255) return { kind: 'unreachable', error: result.stderr.trim() };
    if (result.exitCode === 0) return { kind: 'running' };
    if (tmuxGone(result, this.paths.socket)) return { kind: 'gone' };
    throw new RemoteCommandError(this.target, result.exitCode, result.stdout, result.stderr);
  }

  // The exit code written by run.sh; without that file (session ended by kill-session, or the process ended with the tmux server before run.sh finished)
  // the exit code is null and error says the session is gone
  private async readExit(): Promise<PtyExit> {
    const file = quote([this.paths.exit]);
    const result = await sshExec(this.target, `if [ -e ${file} ]; then cat ${file}; fi`);
    if (result.exitCode === 255) throw new SshConnectError(this.target, result.stderr);
    if (result.exitCode !== 0) {
      throw new RemoteCommandError(this.target, result.exitCode, result.stdout, result.stderr);
    }
    const text = result.stdout.trim();
    if (text === '') {
      return {
        exitCode: null,
        signal: null,
        error: `tmux session ${this.paths.session} is gone and run.sh wrote no exit code`,
      };
    }
    const code = Number(text);
    if (!Number.isInteger(code)) {
      throw new Error(
        `${this.paths.exit} does not hold an exit code: ${JSON.stringify(result.stdout)}`,
      );
    }
    return { exitCode: code, signal: null, error: null };
  }

  // This host's shared reverse forward (a remote port to the dashboard) is written to the remote port file (read by the hook, Contracts 31.4); null when unreachable.
  // Requested again on reconnect: the same port while the master lives, a new one after it disconnected
  private async forward(): Promise<number | null> {
    const ensure = await sshExec(this.target, 'true');
    if (ensure.exitCode === 255) return null;
    const dashboardPort = this.opts.dashboardPort();
    const port = await acquireReverseForward(this.target, dashboardPort, this);
    if (port === null) return null;
    this.forwarded = dashboardPort;
    const written = await sshExec(
      this.target,
      `mkdir -p ${quote([this.paths.dir])} && printf %s ${String(port)} > ${quote([this.paths.port])}`,
    );
    if (written.exitCode === 255) return null;
    if (written.exitCode !== 0) {
      throw new RemoteCommandError(this.target, written.exitCode, written.stdout, written.stderr);
    }
    return port;
  }

  private async cancelForward() {
    if (this.forwarded === null) return;
    const dashboardPort = this.forwarded;
    this.forwarded = null;
    await releaseReverseForward(this.target, dashboardPort, this);
  }

  // Connect to the tmux session until this connection ends: the first time new-session -A creates it and runs run.sh, attach afterwards
  private async attach(first: boolean) {
    const command = first
      ? this.tmux(
          'new-session',
          '-A',
          '-s',
          this.paths.session,
          '-x',
          String(this.cols_),
          '-y',
          String(this.rows_),
          `exec "$SHELL" -lc ${quote([quote(['sh', this.paths.run])])}`,
        )
      : this.tmux('attach-session', '-t', this.paths.session);
    const env = Object.fromEntries(
      Object.entries(process.env).flatMap(([k, v]) => (v === undefined ? [] : [[k, v]])),
    );
    const proc = pty.spawn('ssh', [...sshOptions(this.target), '-tt', this.target, command], {
      name: 'xterm-256color',
      cols: this.cols_,
      rows: this.rows_,
      cwd: process.cwd(),
      env: { ...env, TERM: 'xterm-256color', LANG: env.LANG ?? 'en_US.UTF-8' },
    });
    this.proc = proc;
    proc.onData((data) => {
      this.record.push(data);
    });
    const ended = new Promise<void>((resolve) => {
      proc.onExit(() => {
        resolve();
      });
    });
    this.procEnded = ended;
    if (!first) this.log(`Reconnected to ${this.opts.host.label}`);
    this.setConnected(true);
    await ended;
    this.proc = null;
    this.setConnected(false);
  }

  private setConnected(connected: boolean) {
    if (this.isConnected === connected) return;
    this.isConnected = connected;
    for (const listener of this.connectionListeners) listener(connected);
  }

  private async finish(exit: PtyExit) {
    if (this.exit !== null) return;
    this.exit = exit;
    // Stopping may see the session gone before this connection does (tmuxCommand): disconnect so later output stays out of the finished pty.log
    await this.disconnect();
    await this.cancelForward();
    await this.record.endLog();
    this.resolveExit(exit);
    setImmediate(() => {
      void this.record.release();
    });
  }

  // Connection changes (disconnect and reconnect); returns the unsubscribe function
  onConnection(listener: (connected: boolean) => void): () => void {
    this.connectionListeners.add(listener);
    return () => {
      this.connectionListeners.delete(listener);
    };
  }

  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  get alive(): boolean {
    return this.exit === null;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  backlog(): string {
    return this.record.backlog();
  }

  onData(listener: (data: string) => void): () => void {
    return this.record.onData(listener);
  }

  // Input while disconnected has nowhere to go and is dropped
  write(data: string) {
    if (this.exit !== null)
      throw new Error(`Remote interaction ${this.opts.liveId} has ended and accepts no more input`);
    if (this.proc === null || !this.isConnected) return;
    this.proc.write(data);
  }

  viewport(): Promise<string[]> {
    return this.record.viewport();
  }

  resize(cols: number, rows: number) {
    this.cols_ = cols;
    this.rows_ = rows;
    this.proc?.resize(cols, rows);
    this.record.resizeScreen(cols, rows);
  }

  get cols(): number {
    return this.record.cols;
  }

  get retainedBytesCount(): number {
    return this.record.retainedBytesCount;
  }

  get screenReleased(): boolean {
    return this.record.screenReleased;
  }

  // First step of stopping (Contracts 31.4): tmux send-keys C-c. Claude Code exits only on two presses within a second (measured with 2.1.310),
  // so press again after 0.3 s. If the process exited after the first and the session and tmux server closed, the second reports the session gone
  async interrupt(): Promise<void> {
    const keys = this.tmux('send-keys', '-t', this.paths.session, 'C-c');
    await this.tmuxCommand(`${keys} && sleep 0.3 && ${keys}`);
  }

  // Second step: tmux kill-session
  async forceStop(): Promise<void> {
    await this.tmuxCommand(this.tmux('kill-session', '-t', this.paths.session));
  }

  // Run a tmux command. A report that the session or server is gone means the process has ended: finish with run.sh's exit code without
  // waiting for this connection to drop (run() then sees the session gone; finish records once). Other errors fail with their output
  private async tmuxCommand(command: string) {
    const result = await sshExec(this.target, command);
    if (result.exitCode === 255) throw new SshConnectError(this.target, result.stderr);
    if (result.exitCode === 0) return;
    if (tmuxGone(result, this.paths.socket)) {
      await this.finish(await this.readExit());
      return;
    }
    throw new RemoteCommandError(this.target, result.exitCode, result.stdout, result.stderr);
  }

  // Server shutdown: only drop the local connection, the remote process keeps running in tmux; exited does not complete
  async close(): Promise<void> {
    this.detached = true;
    await this.disconnect();
    await this.cancelForward();
    await this.record.endLog();
    await this.record.release();
  }

  // Drop the local ssh connection (the tmux client exits with it, the session is unaffected) and wait for it to exit
  private async disconnect() {
    this.proc?.kill('SIGHUP');
    await this.procEnded;
  }
}
