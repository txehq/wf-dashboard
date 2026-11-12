import net from 'node:net';
import { execa } from 'execa';
import { quote } from 'shell-quote';
import { z } from 'zod';
import type { RemoteHost } from '../remote/hosts.js';
import {
  RemoteCommandError,
  rsyncPush,
  SshConnectError,
  sshExec,
  sshOptions,
  sshRun,
} from '../remote/ssh.js';
import { remoteRoot, tmuxGone } from '../remote/terminal.js';
import { LANGUAGE_PACK_VSIX_PREFIX, removeLanguagePack } from './language.js';
import { serverArgs } from './server-args.js';

// VS Code for the Web on an SSH host (Contracts 32.3): the server package is downloaded on this machine and put into
// the remote $HOME/.wf-dashboard/vscode/<commit>/ with rsync, runs in the tmux session wfd-vscode listening on the
// remote 127.0.0.1, and a local port is forwarded to it through the host's ControlMaster (ssh -O forward -L). tmux
// uses its own server under vscode/ (socket and config), separate from the interactive tmux server: VS Code keeps
// running when an interactive process ends, its session closes or that server exits

const SESSION = 'wfd-vscode';
const BOUND = /Server bound to 127\.0\.0\.1:(\d+) /;
const READY = 'Extension host agent started.';
const START_TIMEOUT_MS = 90_000;
// No status bar; the session closes when the server exits
const TMUX_CONF = ['set -g status off', 'set -g remain-on-exit off', ''].join('\n');

// The server running on the remote: written by the dashboard once it has started, read when reconnecting after a
// disconnect or a dashboard restart
export const RemoteServerInfo = z.object({
  commit: z.string(),
  version: z.string(),
  // 'en' for servers started with --locale en (Contracts 36.1); servers started before it are replaced when opened
  locale: z.literal('en').optional(),
  port: z.number().int().min(1).max(65535),
  // When startup completed (milliseconds)
  startedAt: z.number(),
});
export type RemoteServerInfo = z.infer<typeof RemoteServerInfo>;

export function remoteVscode(host: RemoteHost) {
  const root = `${remoteRoot(host).root}/vscode`;
  return {
    root,
    socket: `${root}/tmux.sock`,
    conf: `${root}/tmux.conf`,
    pkg: (commit: string) => `${root}/${commit}`,
    serverData: `${root}/server-data`,
    // Where the dashboard put the Chinese language pack's vsix before 36.1
    languagePacks: `${root}/language-packs`,
    token: `${root}/token`,
    log: `${root}/server.log`,
    info: `${root}/server.json`,
  };
}

const tmux = (host: RemoteHost, ...args: string[]) => {
  const p = remoteVscode(host);
  return quote([host.tool('tmux'), '-u', '-S', p.socket, '-f', p.conf, ...args]);
};

// Run a tmux command on the wfd-vscode session: true on success, false when tmux reports the session or the server
// is gone; SshConnectError when the host cannot be reached, other errors (e.g. the remote tmux is gone) fail with
// their output
async function tmuxSession(host: RemoteHost, command: 'has-session' | 'kill-session') {
  const result = await sshExec(host.target, tmux(host, command, '-t', SESSION));
  if (result.exitCode === 255) throw new SshConnectError(host.target, result.stderr);
  if (result.exitCode === 0) return true;
  if (tmuxGone(result, remoteVscode(host).socket)) return false;
  throw new RemoteCommandError(host.target, result.exitCode, result.stdout, result.stderr);
}

// The server recorded for the remote wfd-vscode session while it runs; null when the session is gone or still
// starting and has not written server.json yet
export async function runningRemote(host: RemoteHost): Promise<RemoteServerInfo | null> {
  if (!(await tmuxSession(host, 'has-session'))) return null;
  const file = quote([remoteVscode(host).info]);
  const info = await sshRun(host.target, `if [ -e ${file} ]; then cat ${file}; fi`);
  if (info.trim() === '') return null;
  return RemoteServerInfo.parse(JSON.parse(info));
}

// Put the package extracted on this machine onto the remote: skipped when it is already there; copied to .partial
// first and renamed, so a copy cut off halfway is copied again next time
export async function uploadPackage(host: RemoteHost, localPkg: string, commit: string) {
  const p = remoteVscode(host);
  const dir = p.pkg(commit);
  const present = await sshExec(host.target, `test -f ${quote([`${dir}/product.json`])}`);
  if (present.exitCode === 0) return;
  const partial = `${dir}.partial`;
  await sshRun(host.target, `mkdir -p ${quote([partial])}`);
  await rsyncPush(host.target, host.tool('rsync'), `${localPkg}/`, `${partial}/`, ['--delete']);
  await sshRun(host.target, `mv ${quote([partial])} ${quote([dir])}`);
}

// Remove the Chinese language pack from the remote server-data and its vsix (Contracts 36.1), using the uploaded
// package's own command line, then what uninstalling leaves in server-data/data (removeLanguagePackData)
export async function removeRemoteLanguagePack(host: RemoteHost, commit: string) {
  const p = remoteVscode(host);
  const dir = p.pkg(commit);
  await removeLanguagePack((args) =>
    sshRun(
      host.target,
      quote([
        `${dir}/node`,
        `${dir}/out/server-main.js`,
        ...args,
        '--server-data-dir',
        p.serverData,
        '--accept-server-license-terms',
      ]),
    ),
  );
  const data = `${p.serverData}/data`;
  const vsixs = `${data}/CachedExtensionVSIXs`;
  // find with -name: the remote login shell may be zsh, where an unmatched glob is an error
  await sshRun(
    host.target,
    [
      `rm -rf ${quote([p.languagePacks, `${data}/languagepacks.json`, `${data}/clp`])}`,
      `if [ -d ${quote([vsixs])} ]; then find ${quote([vsixs])} -mindepth 1 -maxdepth 1 -iname ${quote([`${LANGUAGE_PACK_VSIX_PREFIX}*`])} -exec rm -rf {} +; fi`,
    ].join(' && '),
  );
}

// Start the server in the tmux session (the server picks the port), wait until startup completes and return the
// remote port it listens on
export async function startRemote(
  host: RemoteHost,
  release: { commit: string; version: string },
  token: string,
): Promise<RemoteServerInfo> {
  const p = remoteVscode(host);
  const pkg = p.pkg(release.commit);
  await sshRun(host.target, `mkdir -p ${quote([p.serverData])} && cat > ${quote([p.conf])}`, {
    input: TMUX_CONF,
  });
  await sshRun(host.target, `umask 077 && cat > ${quote([p.token])}`, { input: token });
  const server = quote([
    `${pkg}/node`,
    `${pkg}/out/server-main.js`,
    ...serverArgs({ port: 0, tokenFile: p.token, serverDataDir: p.serverData }),
  ]);
  // Run in a login shell so the terminal and the extensions get the same PATH as after the user logs in; output
  // goes to server.log, which gives the port and the end of startup
  const inner = `cd && exec ${server} > ${quote([p.log])} 2>&1`;
  await sshRun(
    host.target,
    `rm -f ${quote([p.info])} && ${tmux(host, 'new-session', '-d', '-s', SESSION, `exec "$SHELL" -lc ${quote([inner])}`)}`,
  );
  const started = Date.now();
  for (;;) {
    const log = await sshExec(host.target, `cat ${quote([p.log])} 2>/dev/null`);
    const port = BOUND.exec(log.stdout)?.[1];
    if (port !== undefined && log.stdout.includes(READY)) {
      const info: RemoteServerInfo = {
        commit: release.commit,
        version: release.version,
        locale: 'en',
        port: Number(port),
        startedAt: Date.now(),
      };
      await sshRun(host.target, `cat > ${quote([p.info])}`, { input: JSON.stringify(info) });
      return info;
    }
    if (!(await tmuxSession(host, 'has-session'))) {
      throw new Error(
        `VS Code server on ${host.label} did not start:\n${log.stdout.slice(-4_000)}`,
      );
    }
    if (Date.now() - started > START_TIMEOUT_MS) {
      throw new Error(
        `VS Code server on ${host.label} did not finish starting within ${String(START_TIMEOUT_MS / 1000)} s:\n${log.stdout.slice(-4_000)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 500));
  }
}

// Stop the remote server: close the tmux session (the server exits with it); when the session is already gone,
// only delete server.json
export async function stopRemote(host: RemoteHost) {
  await tmuxSession(host, 'kill-session');
  await sshRun(host.target, `rm -f ${quote([remoteVscode(host).info])}`);
}

// ssh -O forward or -O cancel: add or remove a local-to-remote forward through the host's ControlMaster
const control = (host: RemoteHost, op: 'forward' | 'cancel', local: number, remote: number) => {
  const spec = `127.0.0.1:${String(local)}:127.0.0.1:${String(remote)}`;
  const args = [...sshOptions(host.target), '-O', op, '-L', spec, host.target];
  return execa('ssh', args, { input: '', reject: false });
};

// Forward a local port to the remote (connecting once first to create the master when there is none)
export async function forward(host: RemoteHost, localPort: number, remotePort: number) {
  await sshRun(host.target, 'true');
  const result = await control(host, 'forward', localPort, remotePort);
  if (result.exitCode !== 0) {
    throw new Error(
      `Forwarding local 127.0.0.1:${String(localPort)} to 127.0.0.1:${String(remotePort)} on ${host.label} failed: ${result.stderr.trim()}`,
    );
  }
}

// Cancel the forward; does nothing when the master is gone
export async function cancelForward(host: RemoteHost, localPort: number, remotePort: number) {
  await control(host, 'cancel', localPort, remotePort);
}

// Whether something listens on the local port (the forward is still there)
export const listening = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
  });

// A free local port
export const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error(`No free port: ${String(address)}`));
        return;
      }
      server.close(() => {
        resolve(address.port);
      });
    });
  });
