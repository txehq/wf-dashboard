import { z } from 'zod';
import type { RemoteHost } from './hosts.js';
import { sshScript } from './ssh.js';

// Remote Codex rollouts (Contracts 31.3, 31.6): path plus id and cwd from the first-line session_meta
const SessionMeta = z.looseObject({
  type: z.literal('session_meta'),
  payload: z.looseObject({
    id: z.string().min(1),
    cwd: z.string(),
    timestamp: z.string().optional(),
  }),
});

export interface RemoteRollout {
  file: string;
  id: string;
  cwd: string;
  firstAt: string | null;
}

// dirs are sessions and archived_sessions under the remote CODEX_HOME; rollouts without a first line yet are not listed
export async function listRemoteRollouts(
  host: RemoteHost,
  dirs: string[],
): Promise<RemoteRollout[]> {
  const out = await sshScript(host.target, 'rollouts.sh', dirs);
  const lines = out.split('\n');
  const rollouts: RemoteRollout[] = [];
  for (let i = 0; i + 1 < lines.length; i += 3) {
    const file = lines[i] ?? '';
    const first = lines[i + 1] ?? '';
    if (file === '' || first.trim() === '') continue;
    const meta = SessionMeta.parse(JSON.parse(first));
    rollouts.push({
      file,
      id: meta.payload.id,
      cwd: meta.payload.cwd,
      firstAt: meta.payload.timestamp ?? null,
    });
  }
  return rollouts;
}
