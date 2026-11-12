import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { type OrcaPlace, orcaCall, orcaStatus } from './cli.js';

// A Live item's Orca identity (Contracts 35.2): the dashboard creates a dedicated Orca terminal per process; in the Live process's environment
// ORCA_TERMINAL_HANDLE is its handle, so agents calling orca start collaboration as this item and receive the messages sent to it.
// The terminal is only an identity: it runs cat, input Orca sends it is discarded; it is closed when the process ends.
// Orca can create terminals only in its workspaces: a Live working directory outside every Orca workspace has no Orca identity, reason says why

export type OrcaIdentity = { handle: string } | { handle: null; reason: string };

const IDENTITY_COMMAND =
  "printf '%s\\n' 'This terminal is the Orca identity of a Live item in wf-dashboard; the agent runs in the dashboard. Closing it does not affect the agent, which just can no longer collaborate through Orca.'; exec cat > /dev/null";

const Worktrees = z.object({
  truncated: z.boolean(),
  worktrees: z.array(z.object({ id: z.string(), path: z.string() })),
});

const Created = z.object({ terminal: z.object({ handle: z.string() }) });

// The Orca workspace containing dir (the longest path); null if none. Compares real paths on this machine
export async function orcaWorkspaceOf(place: OrcaPlace, dir: string): Promise<string | null> {
  const list = Worktrees.parse(await orcaCall(place, ['worktree', 'list', '--limit', '10000']));
  if (list.truncated) {
    throw new Error(
      'orca worktree list output was truncated, cannot find the workspace of the working directory',
    );
  }
  const real = (p: string) => (place.kind === 'local' && fs.existsSync(p) ? fs.realpathSync(p) : p);
  const target = real(dir);
  const inside = list.worktrees
    .map((w) => ({ id: w.id, path: real(w.path) }))
    .filter((w) => target === w.path || target.startsWith(`${w.path}${path.sep}`))
    .sort((a, b) => b.path.length - a.path.length);
  return inside[0]?.id ?? null;
}

export async function createOrcaIdentity(
  place: OrcaPlace,
  liveId: string,
  cwd: string,
): Promise<OrcaIdentity> {
  const status = await orcaStatus(place);
  if (!status.running) return { handle: null, reason: status.reason };
  const workspace = await orcaWorkspaceOf(place, cwd);
  if (workspace === null) {
    return { handle: null, reason: `Working directory ${cwd} is not in any Orca workspace` };
  }
  const created = Created.parse(
    await orcaCall(place, [
      'terminal',
      'create',
      '--worktree',
      `id:${workspace}`,
      '--title',
      `Live ${liveId}`,
      '--command',
      IDENTITY_COMMAND,
    ]),
  );
  return { handle: created.terminal.handle };
}

// Close the identity terminal after the process ends; does nothing when Orca is no longer running or the terminal is gone
export async function closeOrcaIdentity(place: OrcaPlace, handle: string): Promise<void> {
  const status = await orcaStatus(place);
  if (!status.running) return;
  const listed = z
    .object({ terminals: z.array(z.object({ handle: z.string() })) })
    .parse(await orcaCall(place, ['terminal', 'list']));
  if (!listed.terminals.some((t) => t.handle === handle)) return;
  await orcaCall(place, ['terminal', 'close', '--terminal', handle]);
}

// Orca variables in the Live process environment: only this item's identity (and, on an SSH host, the remote runtime location)
export function identityEnv(
  identity: OrcaIdentity,
  userDataPath: string | null,
): Record<string, string> {
  if (identity.handle === null) return {};
  return {
    ORCA_TERMINAL_HANDLE: identity.handle,
    ...(userDataPath === null ? {} : { ORCA_USER_DATA_PATH: userDataPath }),
  };
}
