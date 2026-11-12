import path from 'node:path';
import { quote } from 'shell-quote';
import { HttpError } from '../variants/errors.js';
import type { RemoteHost } from './hosts.js';
import { SshConnectError, sshExec, sshRun, sshScript } from './ssh.js';
import { remoteLive, TMUX_CONF } from './terminal.js';

// Launch files of a remote item (Contracts 31.4): hooks.json and run.sh in the remote live/<liveId>/, the tmux config in $HOME/.wf-dashboard/

const HOOK_EVENTS = ['Stop', 'Notification', 'UserPromptSubmit', 'SessionStart'] as const;

// The hook command reads this connection's reverse-forwarded port, POSTs stdin to /api/live/:id/hook and exits 0 at once (14.2); while disconnected the POST fails and the hook is lost
export function remoteHooks(host: RemoteHost, liveId: string): string {
  const paths = remoteLive(host, liveId);
  const url = `http://127.0.0.1:$(cat ${quote([paths.port])})/api/live/${liveId}/hook`;
  const command = `${quote([host.tool('curl')])} -sS --fail-with-body -m 10 -X POST -H 'content-type: application/json' --data-binary @- "${url}" > /dev/null || true`;
  const hook = { type: 'command', command };
  return `${JSON.stringify(
    {
      skipDangerousModePermissionPrompt: true,
      hooks: {
        ...Object.fromEntries(HOOK_EVENTS.map((name) => [name, [{ hooks: [hook] }]])),
        PreToolUse: [{ matcher: 'AskUserQuestion', hooks: [hook] }],
      },
    },
    null,
    2,
  )}\n`;
}

// run.sh: enter the working directory, run the command with the given environment, then write the exit code (the tmux session closes when its pane ends, so the exit code is read from this file)
export function runScript(
  host: RemoteHost,
  liveId: string,
  spec: { cwd: string; env: Record<string, string>; argv: string[] },
): string {
  const paths = remoteLive(host, liveId);
  const assignments = Object.entries(spec.env).map(([k, v]) => `${k}=${v}`);
  return [
    `rm -f ${quote([paths.exit])}`,
    `cd -- ${quote([spec.cwd])} || { printf 127 > ${quote([paths.exit])}; sleep 5; exit 127; }`,
    `env ${quote(assignments)} ${quote(spec.argv)}`,
    `printf %s "$?" > ${quote([paths.exit])}`,
    '',
  ].join('\n');
}

// Write the remote files: tmux.conf, hooks.json and run.sh under live/<liveId>/. On the remote the dashboard writes only $HOME/.wf-dashboard/
export async function writeRemoteLive(
  host: RemoteHost,
  liveId: string,
  files: { hooks: string | null; run: string },
): Promise<void> {
  const paths = remoteLive(host, liveId);
  await sshRun(host.target, `mkdir -p ${quote([paths.dir])} && cat > ${quote([paths.conf])}`, {
    input: TMUX_CONF,
  });
  if (files.hooks !== null) {
    await sshRun(host.target, `cat > ${quote([paths.hooks])}`, { input: files.hooks });
  }
  await sshRun(host.target, `cat > ${quote([paths.run])}`, { input: files.run });
}

// What resuming a remote session does in the target config (the rules of Contracts 14.5, comparing the two copies on the remote): the
// target config is the remote machine's ~/.claude or the variant's config directory, the projects directory name is the session's original one
export type RemoteResumeAction = 'missing' | 'resume' | 'copy' | 'sync' | 'diverged';

export function remoteProjectsDir(configDir: string, remotePath: string): string {
  return `${configDir}/projects/${path.posix.basename(path.posix.dirname(remotePath))}`;
}

export async function remoteResumeAction(
  host: RemoteHost,
  remotePath: string,
  configDir: string,
  sessionId: string,
): Promise<{ action: RemoteResumeAction; target: string; targetBytes: number | null }> {
  const dir = remoteProjectsDir(configDir, remotePath);
  const out = await sshScript(host.target, 'resume.sh', ['check', remotePath, dir, sessionId]);
  const [action = '', , bytes] = out.split('\n');
  if (!['missing', 'resume', 'copy', 'sync', 'diverged'].includes(action)) {
    throw new Error(`Unrecognized resume.sh output: ${out}`);
  }
  return {
    action: action as RemoteResumeAction,
    target: `${dir}/${sessionId}.jsonl`,
    targetBytes: bytes === undefined || bytes === '' ? null : Number(bytes),
  };
}

// Copy or sync as the precheck said, returning the copy in the target config; useLatest is "continue from the latest" when the two diverged
export async function applyRemoteResume(
  host: RemoteHost,
  remotePath: string,
  configDir: string,
  sessionId: string,
  useLatest: boolean,
): Promise<string> {
  const dir = remoteProjectsDir(configDir, remotePath);
  const out = await sshScript(host.target, 'resume.sh', [
    useLatest ? 'apply-diverged' : 'apply',
    remotePath,
    dir,
    sessionId,
  ]);
  return out.trim();
}

// The remote directory must already exist (Contracts 31.3), otherwise fail with cd's output
export async function requireRemoteDir(host: RemoteHost, dir: string): Promise<void> {
  if (!dir.startsWith('/'))
    throw new HttpError(400, `The remote working path must be absolute: ${dir}`);
  const result = await sshExec(host.target, `cd -- ${quote([dir])}`);
  if (result.exitCode === 255) throw new SshConnectError(host.target, result.stderr);
  if (result.exitCode !== 0) {
    throw new HttpError(400, `${host.label}:${dir}: ${result.stderr.trim()}`);
  }
}
