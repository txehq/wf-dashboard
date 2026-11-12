import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { quote } from 'shell-quote';
import { config } from '../config.js';
import { HttpError } from '../variants/errors.js';

// ssh connections and remote commands (Contracts 31.1): always this machine's ssh (reads ~/.ssh/config and ssh-agent), key auth only, no password prompt;
// connections to one host are reused through ControlMaster. W96 (variants on a remote) uses these functions too

const BASE_OPTIONS = [
  '-o',
  'BatchMode=yes',
  '-o',
  'ConnectTimeout=10',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=4',
];

// ssh appends a 17-character random suffix when binding ControlPath (measured with OpenSSH 10.3); macOS socket paths are at most 104 bytes
const SOCKET_SUFFIX = 17;
const SOCKET_MAX = 104;

// A host's ControlPath: named by the hash of target inside the directory
export function controlPath(target: string): string {
  const name = createHash('sha256').update(target).digest('hex').slice(0, 12);
  const file = path.join(config.sshControlDir, name);
  if (Buffer.byteLength(file) + SOCKET_SUFFIX >= SOCKET_MAX) {
    throw new Error(
      `ControlPath ${file} is too long: with ssh's ${String(SOCKET_SUFFIX)}-character suffix it exceeds the macOS socket path limit of ${String(SOCKET_MAX)} bytes; set WFD_SSH_CONTROL_DIR to a shorter directory`,
    );
  }
  if (/\s/.test(file))
    throw new Error(`ControlPath ${file} contains whitespace, which rsync's -e cannot pass`);
  return file;
}

// All ssh options for connecting to this host (without target)
export function sshOptions(target: string): string[] {
  fs.mkdirSync(config.sshControlDir, { recursive: true, mode: 0o700 });
  return [
    ...BASE_OPTIONS,
    '-o',
    'ControlMaster=auto',
    '-o',
    'ControlPersist=10m',
    '-o',
    `ControlPath=${controlPath(target)}`,
  ];
}

// Unreachable (ssh exits with 255): message is ssh's stderr
export class SshConnectError extends HttpError {
  constructor(
    readonly target: string,
    readonly stderr: string,
  ) {
    super(
      502,
      stderr.trim() === ''
        ? `Cannot reach ${target} (ssh exited with 255 and no output)`
        : stderr.trim(),
    );
    this.name = 'SshConnectError';
  }
}

// Connected, but the remote command exited non-zero: message is its stderr (stdout when stderr is empty)
export class RemoteCommandError extends HttpError {
  constructor(
    readonly target: string,
    readonly exitCode: number,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    const text = (stderr.trim() === '' ? stdout : stderr).trim();
    super(
      500,
      text === '' ? `Command on ${target} exited with ${String(exitCode)} and no output` : text,
    );
    this.name = 'RemoteCommandError';
  }
}

export interface SshResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

// Run a one-line command on the remote (interpreted by the remote user's shell), input is its stdin; returns the exit code and output either way (255 means unreachable)
export async function sshExec(
  target: string,
  command: string,
  opts: { input?: string } = {},
): Promise<SshResult> {
  const result = await execa('ssh', [...sshOptions(target), target, command], {
    input: opts.input ?? '',
    reject: false,
  });
  return { exitCode: result.exitCode ?? -1, stdout: result.stdout, stderr: result.stderr };
}

// As above, throwing on failure: SshConnectError when unreachable, RemoteCommandError when the command fails; returns stdout
export async function sshRun(
  target: string,
  command: string,
  opts: { input?: string } = {},
): Promise<string> {
  const result = await sshExec(target, command, opts);
  if (result.exitCode === 255) throw new SshConnectError(target, result.stderr);
  if (result.exitCode !== 0) {
    throw new RemoteCommandError(target, result.exitCode, result.stdout, result.stderr);
  }
  return result.stdout;
}

// Remote scripts shipped with the dashboard (server/remote-scripts/)
const scriptsDir = fileURLToPath(new URL('../../remote-scripts/', import.meta.url));

// Command line and stdin for running a script remotely: the script goes over stdin, leaving no file on the remote; with login it runs in
// the remote user's login shell, with the PATH of a logged-in user (claude often lives in ~/.local/bin, added to PATH by ~/.profile)
function scriptCommand(script: string, args: string[], login: boolean) {
  const body = fs.readFileSync(path.join(scriptsDir, script), 'utf8');
  const sh = quote(['sh', '-s', '--', ...args]);
  return { command: login ? `exec "$SHELL" -lc ${quote([sh])}` : sh, input: body };
}

export async function sshScript(
  target: string,
  script: string,
  args: string[],
  opts: { login?: boolean } = {},
): Promise<string> {
  const { command, input } = scriptCommand(script, args, opts.login === true);
  return sshRun(target, command, { input });
}

// As above, returning the exit code and output either way
export async function sshScriptResult(
  target: string,
  script: string,
  args: string[],
  opts: { login?: boolean } = {},
): Promise<SshResult> {
  const { command, input } = scriptCommand(script, args, opts.login === true);
  return sshExec(target, command, { input });
}

// Close this host's ControlMaster (on server shutdown); does nothing without a master
export async function closeMaster(target: string): Promise<void> {
  const socket = controlPath(target);
  if (!fs.existsSync(socket)) return;
  await execa('ssh', [...sshOptions(target), '-O', 'exit', target], { input: '', reject: false });
}

// rsync's -e: the same options as ssh (through the same ControlMaster). macOS openrsync splits -e on whitespace only and keeps quotes
// and escapes, so options may contain no whitespace and get no quotes
export function rsyncShell(target: string): string {
  const args = ['ssh', ...sshOptions(target)];
  const spaced = args.find((a) => /\s/.test(a));
  if (spaced !== undefined)
    throw new Error(`rsync's -e cannot pass an ssh option containing whitespace: ${spaced}`);
  return args.join(' ');
}

// Copy from the remote to this machine (rsync): remote is the remote path, local the local path; rsyncPath is where the remote rsync is (recorded by the check)
export async function rsyncPull(
  target: string,
  rsyncPath: string,
  remote: string,
  local: string,
  extra: string[] = [],
): Promise<void> {
  await rsyncRun(target, [...extra, `--rsync-path=${rsyncPath}`, `${target}:${remote}`, local]);
}

// Copy from this machine to the remote
export async function rsyncPush(
  target: string,
  rsyncPath: string,
  local: string,
  remote: string,
  extra: string[] = [],
): Promise<void> {
  await rsyncRun(target, [...extra, `--rsync-path=${rsyncPath}`, local, `${target}:${remote}`]);
}

async function rsyncRun(target: string, args: string[]) {
  const result = await rsyncResult(target, args);
  if (result.exitCode !== 0) {
    throw new RemoteCommandError(target, result.exitCode, result.stdout, result.stderr);
  }
}

// rsync, returning the exit code and output either way; remote paths in args are written <target>:<path>
export async function rsyncResult(target: string, args: string[]): Promise<SshResult> {
  const result = await execa('rsync', ['-a', '-e', rsyncShell(target), ...args], {
    input: '',
    reject: false,
  });
  return { exitCode: result.exitCode ?? -1, stdout: result.stdout, stderr: result.stderr };
}
