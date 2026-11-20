import { execa } from 'execa';
import { quote } from 'shell-quote';
import { z } from 'zod';
import type { RemoteHost } from '../remote/hosts.js';
import { SshConnectError, sshExec } from '../remote/ssh.js';

// Orca's CLI (Contracts section 35): orca runs directly on this machine, on SSH hosts the remote orca runs over the same ssh connection; always
// with --json, reading result from the envelope, failing with Orca's error code and message when ok is false

export type OrcaPlace = { kind: 'local'; bin: string } | { kind: 'remote'; host: RemoteHost };

export class OrcaError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly args: string[],
  ) {
    super(`orca ${args.join(' ')} failed (${code}): ${message}`);
  }
}

const Envelope = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), result: z.unknown() }),
  z.object({ ok: z.literal(false), error: z.object({ code: z.string(), message: z.string() }) }),
]);

// Process environment without any ORCA_* variable (Contracts 35.2): the identity of the Orca terminal running the dashboard server does not
// reach the orca the dashboard calls or the Live processes it starts. identity is the terminal to act as
export function orcaFreeEnv(
  env: NodeJS.ProcessEnv,
  extra: { identity?: string | null } = {},
): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && !entry[0].startsWith('ORCA_'),
      ),
    ),
    ...(extra.identity == null ? {} : { ORCA_TERMINAL_HANDLE: extra.identity }),
  };
}

// The Orca runtime used on an SSH host (Contracts 35.6): the one the local Orca app deployed over ssh and paired with (the remote user's ~/.orca),
// holding the workspaces the user opened in Orca. Remote orca commands, Live processes and host checks all point at it
export function remoteOrcaUserData(host: RemoteHost): string {
  return `${host.home}/.orca`;
}

function parseEnvelope(stdout: string, args: string[], stderr: string): unknown {
  const text = stdout.trim();
  if (text === '') throw new OrcaError('no_output', `No output: ${stderr.trim()}`, args);
  const envelope = Envelope.parse(JSON.parse(text));
  if (!envelope.ok) throw new OrcaError(envelope.error.code, envelope.error.message, args);
  return envelope.result;
}

// Run one orca command and return result from the envelope; identity is the Orca terminal it acts as (needed by commands that start collaboration).
// cwd is the directory orca runs in: it decides which Run a command is scoped to (see ANY_RUN_DIR)
export async function orcaCall(
  place: OrcaPlace,
  args: string[],
  identity: string | null = null,
  cwd: string | null = null,
): Promise<unknown> {
  const full = [...args, '--json'];
  if (place.kind === 'local') {
    const result = await execa(place.bin, full, {
      env: orcaFreeEnv(process.env, { identity }),
      extendEnv: false,
      reject: false,
      input: '',
      ...(cwd === null ? {} : { cwd }),
    });
    return parseEnvelope(result.stdout, args, result.stderr);
  }
  const host = place.host;
  const command = quote([
    'env',
    `ORCA_USER_DATA_PATH=${remoteOrcaUserData(host)}`,
    ...(identity === null ? [] : [`ORCA_TERMINAL_HANDLE=${identity}`]),
    host.tool('orca'),
    ...full,
  ]);
  const result = await sshExec(
    host.target,
    cwd === null ? command : `cd ${quote([cwd])} && ${command}`,
  );
  if (result.exitCode === 255) throw new SshConnectError(host.target, result.stderr);
  return parseEnvelope(result.stdout, args, result.stderr);
}

// Remote Orca runtimes the desktop Orca on this machine has paired with (orca environment list)
export const OrcaEnvironments = z.object({
  environments: z.array(z.object({ id: z.string(), name: z.string() })),
});

// What orca terminal switch did in the desktop app: the worktree and tab it put on screen
const TerminalFocus = z.object({
  focus: z.object({
    handle: z.string(),
    tabId: z.string(),
    worktreeId: z.string(),
    navigated: z.boolean(),
  }),
});

// The desktop Orca app (macOS bundle id). macOS keeps a background process from bringing another app forward (open -b
// and AppleScript's activate leave it behind), but Orca answers a second launch by raising its own window, and that
// launch exits right away
const ORCA_APP_BUNDLE = 'com.stablyai.orca';

// "Open in Orca" (Contracts 40.2): the desktop Orca on this machine opens the terminal's worktree and tab (orca
// terminal switch does both), then comes to the front. environment names the paired Orca server a terminal on an SSH
// host belongs to
export async function showOrcaTerminal(
  place: Extract<OrcaPlace, { kind: 'local' }>,
  handle: string,
  environment: string | null,
): Promise<void> {
  const args = [
    'terminal',
    'switch',
    '--terminal',
    handle,
    ...(environment === null ? [] : ['--environment', environment]),
  ];
  const { focus } = TerminalFocus.parse(await orcaCall(place, args));
  if (!focus.navigated) {
    throw new OrcaError('not_navigated', `Orca did not show the tab of ${handle}`, args);
  }
  await execa('open', ['-n', '-b', ORCA_APP_BUNDLE]);
}

const Status = z.object({
  runtime: z.object({
    reachable: z.boolean(),
    state: z.string(),
    appVersion: z.string().optional(),
  }),
});
// Whether Orca's runtime is running (Contracts 35.2): if not, give the reason; the Live item then has no Orca identity and the topology is empty.
// Called once before each Live process starts: locally runs orca status once, a missing orca command shows as its failure to start
export async function orcaStatus(
  place: OrcaPlace,
): Promise<{ running: true; version: string } | { running: false; reason: string }> {
  let result: unknown;
  if (place.kind === 'local') {
    const args = ['status', '--json'];
    const probe = await execa(place.bin, args, {
      env: orcaFreeEnv(process.env),
      extendEnv: false,
      reject: false,
      input: '',
    });
    if (probe.failed && probe.exitCode === undefined) {
      return {
        running: false,
        reason: `No orca command on this machine (${place.bin}): ${String(probe.message)}`,
      };
    }
    result = parseEnvelope(probe.stdout, ['status'], probe.stderr);
  } else {
    result = await orcaCall(place, ['status']);
  }
  const status = Status.parse(result);
  if (!status.runtime.reachable) {
    return { running: false, reason: `Orca is not running (runtime is ${status.runtime.state})` };
  }
  return { running: true, version: status.runtime.appVersion ?? '' };
}

// Since 1.4.246 the orchestration list commands print a concise view by default, which drops the Run's coordinator and
// creation time, the worker's Run, the task's spec and the whole body of a message; --full prints the record Orca
// returned (Contracts 35.3). Older Orca, such as the 1.4.227 on the SSH host, has no concise view and rejects the flag
// as unknown, so each place is asked once which it is and the answer is kept for as long as its version is unchanged
const fullFlag = new Map<string, { version: string; supported: boolean }>();

// Where the orchestration reads run. orca scopes worker-list to the Run bound to the Orca worktree the command runs
// in, and reports which in the receipt's scope; the topology is every Run on the machine (Contracts 35.3), so the
// reads run from a directory that is in no workspace. The dashboard's own directory usually is one
const ANY_RUN_DIR = '/';

const placeKey = (place: OrcaPlace) => (place.kind === 'local' ? place.bin : place.host.target);

async function supportsFull(place: OrcaPlace, version: string): Promise<boolean> {
  const key = placeKey(place);
  const known = fullFlag.get(key);
  if (known?.version === version) return known.supported;
  const args = ['orchestration', 'run-list', '--help'];
  const help =
    place.kind === 'local'
      ? (
          await execa(place.bin, args, {
            env: orcaFreeEnv(process.env),
            extendEnv: false,
            reject: false,
            input: '',
          })
        ).stdout
      : (
          await sshExec(
            place.host.target,
            quote([
              'env',
              `ORCA_USER_DATA_PATH=${remoteOrcaUserData(place.host)}`,
              place.host.tool('orca'),
              ...args,
            ]),
          )
        ).stdout;
  const supported = /^\s*--full\b/m.test(help);
  fullFlag.set(key, { version, supported });
  return supported;
}

// One orchestration read: the full record wherever Orca can print it, covering every Run on the machine
export async function orcaRead(
  place: OrcaPlace,
  version: string,
  args: string[],
): Promise<unknown> {
  const full = (await supportsFull(place, version)) ? ['--full'] : [];
  return orcaCall(place, [...args, ...full], null, ANY_RUN_DIR);
}
