import { z } from 'zod';

// VS Code for the Web servers (Contracts section 32): one per machine; this machine's id is local, an SSH host's is
// ssh:<hostId>
export const LOCAL_SERVER_ID = 'local';

export const remoteServerId = (hostId: string) => `ssh:${hostId}`;

// Platform of the VS Code for the Web server package: the <platform> in server-<platform>-web on
// update.code.visualstudio.com
export const VscodePlatform = z.enum([
  'darwin-arm64',
  'darwin',
  'linux-x64',
  'linux-arm64',
  'linux-armhf',
]);
export type VscodePlatform = z.infer<typeof VscodePlatform>;

// The platform for the output of uname -sm (e.g. "Linux x86_64"); null when there is no server package for it.
// Shown in the SSH host check (32.3)
export function platformOfUname(uname: string): VscodePlatform | null {
  const [system, machine] = uname.trim().split(/\s+/);
  if (system === 'Darwin') {
    if (machine === 'arm64') return 'darwin-arm64';
    if (machine === 'x86_64') return 'darwin';
    return null;
  }
  if (system === 'Linux') {
    if (machine === 'x86_64') return 'linux-x64';
    if (machine === 'aarch64' || machine === 'arm64') return 'linux-arm64';
    if (machine === 'armv7l') return 'linux-armhf';
    return null;
  }
  return null;
}

// Preparation steps: look up the version, download the server package, extract it, copy it to the SSH host, start
// it, forward a local port to the remote one
export const VscodePhase = z.enum([
  'checking',
  'downloading',
  'extracting',
  'uploading',
  'starting',
  'forwarding',
]);
export type VscodePhase = z.infer<typeof VscodePhase>;

export const VscodeServerView = z.object({
  id: z.string(),
  // This machine, or the SSH host's label
  machine: z.string(),
  // unreachable: the dashboard could not reach this SSH host at startup and does not know whether its server is
  // still there (error is the ssh output)
  status: z.enum(['preparing', 'running', 'failed', 'unreachable']),
  // The step while preparing; while downloading, received / total are bytes (total from content-length)
  phase: VscodePhase.nullable(),
  received: z.number().nullable(),
  total: z.number().nullable(),
  // VS Code's version (e.g. 1.143.1) and the server package's commit; empty until the version is known
  version: z.string().nullable(),
  commit: z.string().nullable(),
  port: z.number().nullable(),
  pid: z.number().nullable(),
  startedAt: z.string().nullable(),
  // The error output when failed
  error: z.string().nullable(),
});
export type VscodeServerView = z.infer<typeof VscodeServerView>;

export const VscodeOpenResult = z.union([
  z.object({ url: z.string() }),
  z.object({ progress: VscodeServerView }),
]);
export type VscodeOpenResult = z.infer<typeof VscodeOpenResult>;
