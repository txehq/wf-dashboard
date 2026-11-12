import path from 'node:path';
import { quote } from 'shell-quote';
import type { RemoteHost } from './hosts.js';
import { sshRun } from './ssh.js';

// Permanently delete a session on an SSH host (Contracts 31.6, 25.3): the caller deletes the local copy, this deletes the remote originals

// Remote files deleted with a Claude Code session (as on the local machine: the main jsonl, the same-named directory, and under
// projects also file-history/<id> and session-env/<id>); lists only those that exist
export async function remoteClaudeFiles(
  host: RemoteHost,
  id: string,
  remotePath: string,
): Promise<string[]> {
  const projectDir = path.posix.dirname(remotePath);
  const candidates = [remotePath, `${projectDir}/${id}`];
  if (path.posix.basename(path.posix.dirname(projectDir)) === 'projects') {
    const configDir = path.posix.dirname(path.posix.dirname(projectDir));
    candidates.push(`${configDir}/file-history/${id}`, `${configDir}/session-env/${id}`);
  }
  const out = await sshRun(
    host.target,
    `for f in ${quote(candidates)}; do [ -e "$f" ] && printf '%s\\n' "$f"; done; exit 0`,
  );
  return out.split('\n').filter((l) => l !== '');
}

export async function deleteRemoteFiles(host: RemoteHost, files: string[]): Promise<void> {
  if (files.length === 0) return;
  await sshRun(host.target, `rm -rf -- ${quote(files)}`);
}

// A Codex rollout is deleted permanently on the remote by codex delete (as locally, 25.3), run in the remote user's login shell
export async function remoteCodexDelete(host: RemoteHost, id: string): Promise<void> {
  await sshRun(
    host.target,
    `exec "$SHELL" -lc ${quote([quote([host.tool('codex'), 'delete', '--force', id])])}`,
  );
}
