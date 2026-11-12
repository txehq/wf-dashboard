import { z } from 'zod';

// Shapes of the SSH host API (Contracts 31.1, 31.2)

// A remote command: when found, path is where it is on the login shell's PATH and output is the output of --version or
// similar (the shell's output when not found)
export const RemoteTool = z.object({
  found: z.boolean(),
  path: z.string().nullable(),
  output: z.string(),
});
export type RemoteTool = z.infer<typeof RemoteTool>;

export const remoteToolNames = ['claude', 'codex', 'tmux', 'rsync', 'curl', 'orca'] as const;
export type RemoteToolName = (typeof remoteToolNames)[number];

export const remoteEngines = ['claude', 'codex'] as const;
export type RemoteEngine = (typeof remoteEngines)[number];

// Orca on the remote (Contracts 35.6): running is true when the orca command exists and its runtime (orca serve or the
// Orca app) runs, with version the runtime's version; otherwise problem states why, and items on that host have no
// Orca identity and no collaboration in the topology
export const HostOrca = z.object({
  running: z.boolean(),
  version: z.string().nullable(),
  problem: z.string().nullable(),
});
export type HostOrca = z.infer<typeof HostOrca>;

// The result of one check (ssh_hosts.check): when unreachable, error is ssh's stderr and the rest is empty
export const HostCheck = z.object({
  at: z.number(),
  connected: z.boolean(),
  error: z.string().nullable(),
  // uname -sm, e.g. Linux x86_64
  platform: z.string().nullable(),
  home: z.string().nullable(),
  tools: z.record(z.enum(remoteToolNames), RemoteTool).nullable(),
  // Workflows whose remote ~/.claude/skills/<entry skill>/SKILL.md exists (the entry commands of Contracts 29.2)
  entries: z.array(z.string()),
  // Reasons nothing can start, whatever the engine: unreachable, no tmux, rsync or curl (hooks POST stdin to the
  // dashboard with curl)
  problems: z.array(z.string()),
  // Engines the remote has
  engines: z.array(z.enum(remoteEngines)),
  // Checks saved before W104 lack this
  orca: HostOrca.optional(),
});
export type HostCheck = z.infer<typeof HostCheck>;

export const SshHostView = z.object({
  id: z.string(),
  target: z.string(),
  label: z.string(),
  createdAt: z.number(),
  checkedAt: z.number().nullable(),
  check: HostCheck.nullable(),
  // A Live process is running (the host cannot be deleted then)
  running: z.boolean(),
});
export type SshHostView = z.infer<typeof SshHostView>;

export const SshHostList = z.object({
  hosts: z.array(SshHostView),
  // Hosts in ~/.ssh/config (no wildcards, not added yet) to pick directly
  configHosts: z.array(z.string()),
});
export type SshHostList = z.infer<typeof SshHostList>;

// user@host or a Host name from ~/.ssh/config: does not start with - (so ssh does not take it as an option) and has
// no whitespace or shell special characters
export const SshTarget = z
  .string()
  .trim()
  .regex(
    /^[A-Za-z0-9_.@[\]:%][A-Za-z0-9_.@[\]:%-]*$/,
    'Use user@host or a Host name from ~/.ssh/config',
  );

export const AddHostBody = z.strictObject({ target: SshTarget });
export const RenameHostBody = z.strictObject({ label: z.string() });
// reuse: reuse a check result from the last 60 seconds (when the new-Live form picks a host); check again when absent
export const CheckHostBody = z.strictObject({ reuse: z.boolean().optional() });
