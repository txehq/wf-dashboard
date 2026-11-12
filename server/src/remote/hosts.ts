import fs from 'node:fs';
import path from 'node:path';
import { and, asc, eq, isNull } from 'drizzle-orm';
import SSHConfig from 'ssh-config';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { liveProcesses, liveSessions, sshHosts, workflowTable } from '../db/schema.js';
import { type DirList, existsMessage, folderNameProblem, type NewDir } from '../dirs/views.js';
import { events } from '../events.js';
import { newId } from '../runs/index.js';
import { HttpError } from '../variants/errors.js';
import {
  closeMaster,
  RemoteCommandError,
  SshConnectError,
  sshScript,
  sshScriptResult,
} from './ssh.js';
import {
  type HostCheck,
  type HostOrca,
  type RemoteEngine,
  type RemoteTool,
  remoteToolNames,
  type SshHostList,
  type SshHostView,
} from './views.js';

// SSH hosts (Contracts 31.1, 31.2): add, rename, check, delete, browse remote directories

type HostRow = typeof sshHosts.$inferSelect;

// A checked, reachable host: the remote HOME and the location of each command
export interface RemoteHost {
  id: string;
  target: string;
  label: string;
  home: string;
  check: HostCheck;
  tool(name: (typeof remoteToolNames)[number]): string;
}

// When a host is chosen in the new-interaction form, a check from the last 60 seconds is reused (Contracts 31.2)
const REUSE_MS = 60_000;

const ENGINE_NAMES: Record<RemoteEngine, string> = { claude: 'Claude Code', codex: 'Codex' };

// check.sh output: each item starts with "@@wfd <item> <exit code>"
function parseCheck(stdout: string, at: number): HostCheck {
  const sections: { name: string; code: number; lines: string[] }[] = [];
  for (const line of stdout.split('\n')) {
    const head = /^@@wfd (\S+) (\d+)$/.exec(line);
    if (head !== null) {
      sections.push({ name: head[1] ?? '', code: Number(head[2]), lines: [] });
      continue;
    }
    const last = sections.at(-1);
    if (last === undefined) continue;
    last.lines.push(line);
  }
  const text = (lines: string[]) => lines.join('\n').trim();
  const section = (name: string) => {
    const found = sections.find((s) => s.name === name);
    if (found === undefined) throw new Error(`Check output has no ${name} item:\n${stdout}`);
    return found;
  };
  const tools = Object.fromEntries(
    remoteToolNames.map((name): [string, RemoteTool] => {
      const s = section(name);
      const [first = '', ...rest] = s.lines;
      return [
        name,
        s.code === 0
          ? { found: true, path: first.trim(), output: text(rest) }
          : { found: false, path: null, output: text(s.lines) },
      ];
    }),
  ) as Record<(typeof remoteToolNames)[number], RemoteTool>;
  const problems = (['tmux', 'rsync', 'curl'] as const)
    .filter((name) => !tools[name].found)
    .map((name) => `No ${name}: ${tools[name].output}`);
  return {
    at,
    connected: true,
    error: null,
    platform: text(section('uname').lines),
    home: text(section('home').lines),
    tools,
    entries: sections.filter((s) => s.name === 'entry').map((s) => text(s.lines)),
    problems,
    engines: (['claude', 'codex'] as const).filter((e) => tools[e].found),
    orca: hostOrca(tools.orca, sections.find((s) => s.name === 'orca-status') ?? null),
  };
}

const OrcaStatusOutput = z.object({
  ok: z.literal(true),
  result: z.object({
    runtime: z.object({
      reachable: z.boolean(),
      state: z.string(),
      appVersion: z.string().optional(),
    }),
  }),
});

// Orca on the remote (Contracts 35.6): states when orca is missing or its runtime is not running
function hostOrca(tool: RemoteTool, status: { code: number; lines: string[] } | null): HostOrca {
  if (!tool.found || status === null) {
    return { running: false, version: null, problem: `No orca: ${tool.output}` };
  }
  const output = status.lines.join('\n').trim();
  if (status.code !== 0) {
    return {
      running: false,
      version: null,
      problem: `orca status exited with ${String(status.code)}: ${output}`,
    };
  }
  const runtime = OrcaStatusOutput.parse(JSON.parse(output)).result.runtime;
  if (!runtime.reachable) {
    return {
      running: false,
      version: null,
      problem: `The Orca runtime of ~/.orca is not running (${runtime.state}): connect to this host in the Orca app on this machine`,
    };
  }
  return { running: true, version: runtime.appVersion ?? null, problem: null };
}

// Host names in ~/.ssh/config (without wildcards and negations); empty when the file does not exist
function configHostNames(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  const names: string[] = [];
  for (const line of SSHConfig.parse(fs.readFileSync(file, 'utf8'))) {
    if (!('param' in line) || line.param.toLowerCase() !== 'host') continue;
    const values = typeof line.value === 'string' ? [line.value] : line.value.map((v) => v.val);
    for (const value of values) {
      if (!/[*?!]/.test(value)) names.push(value);
    }
  }
  return [...new Set(names)];
}

export function createHosts(deps: { db: Db; sshHostsFile: string }) {
  const { db } = deps;

  function row(id: string): HostRow {
    const found = db.select().from(sshHosts).where(eq(sshHosts.id, id)).get();
    if (found === undefined) throw new HttpError(404, `SSH host not found: ${id}`);
    return found;
  }

  // A host with running interactions cannot be deleted (Contracts 31.1)
  function running(id: string): boolean {
    return (
      db
        .select({ id: liveProcesses.id })
        .from(liveProcesses)
        .innerJoin(liveSessions, eq(liveSessions.id, liveProcesses.liveId))
        .where(and(eq(liveSessions.hostId, id), eq(liveProcesses.status, 'running')))
        .get() !== undefined
    );
  }

  function view(r: HostRow): SshHostView {
    return {
      id: r.id,
      target: r.target,
      label: r.label,
      createdAt: r.createdAt.getTime(),
      checkedAt: r.checkedAt === null ? null : r.checkedAt.getTime(),
      check: r.check,
      running: running(r.id),
    };
  }

  // Names of each workflow's entry skill (whether the remote has it installed, 29.2)
  function entryNames(): string[] {
    return db
      .select({ id: workflowTable.id })
      .from(workflowTable)
      .where(isNull(workflowTable.deletedAt))
      .orderBy(asc(workflowTable.createdAt), asc(workflowTable.id))
      .all()
      .map((w) => w.id);
  }

  // Once connected, read the remote platform, HOME, commands and entry skills; when unreachable, error is ssh's output
  async function probe(target: string): Promise<HostCheck> {
    const result = await sshScriptResult(target, 'check.sh', entryNames(), { login: true });
    const at = Date.now();
    if (result.exitCode === 255) {
      return {
        at,
        connected: false,
        error: result.stderr.trim() === '' ? `Cannot reach ${target}` : result.stderr.trim(),
        platform: null,
        home: null,
        tools: null,
        entries: [],
        problems: [result.stderr.trim() === '' ? `Cannot reach ${target}` : result.stderr.trim()],
        engines: [],
      };
    }
    if (result.exitCode !== 0) {
      throw new Error(
        `Check script exited with ${String(result.exitCode)}: ${result.stderr}${result.stdout}`,
      );
    }
    return parseCheck(result.stdout, at);
  }

  function save(id: string, check: HostCheck) {
    db.update(sshHosts)
      .set({ check, checkedAt: new Date(check.at) })
      .where(eq(sshHosts.id, id))
      .run();
    events.publish({ type: 'ssh-hosts.updated' });
  }

  async function check(id: string, reuse = false): Promise<SshHostView> {
    const r = row(id);
    if (reuse && r.check !== null && Date.now() - r.check.at < REUSE_MS) return view(r);
    save(id, await probe(r.target));
    return view(row(id));
  }

  // Before launch and resume (no reuse, Contracts 31.2): reject with the output when unreachable or missing tmux, rsync, curl or the chosen engine
  async function ready(id: string, engine: RemoteEngine): Promise<RemoteHost> {
    await check(id);
    const r = row(id);
    const c = r.check;
    if (c === null) throw new Error(`Host ${id} has no result after the check`);
    const problems = [...c.problems];
    if (c.connected && !c.engines.includes(engine)) {
      problems.push(`No ${ENGINE_NAMES[engine]}: ${c.tools?.[engine].output ?? ''}`);
    }
    if (problems.length > 0) {
      throw new HttpError(400, `Cannot launch on ${r.label}: ${problems.join('; ')}`);
    }
    return remoteHost(r);
  }

  // A checked, reachable host (for reconnect and sync, without a new check)
  function known(id: string): RemoteHost {
    return remoteHost(row(id));
  }

  function remoteHost(r: HostRow): RemoteHost {
    const c = r.check;
    if (c?.home == null || c.tools === null) {
      throw new HttpError(409, `Host ${r.label} has not passed a check yet`);
    }
    const tools = c.tools;
    return {
      id: r.id,
      target: r.target,
      label: r.label,
      home: c.home,
      check: c,
      tool(name) {
        const t = tools[name];
        if (!t.found || t.path === null) throw new HttpError(400, `No ${name} on ${r.label}`);
        return t.path;
      },
    };
  }

  return {
    // Hosts where Orca was running at the latest check (Contracts 35.6): the topology reads their collaborations
    withOrca(): RemoteHost[] {
      return db
        .select()
        .from(sshHosts)
        .orderBy(asc(sshHosts.createdAt))
        .all()
        .filter((r) => r.check?.connected === true && r.check.orca?.running === true)
        .map(remoteHost);
    },
    list(): SshHostList {
      const hosts = db.select().from(sshHosts).orderBy(asc(sshHosts.createdAt)).all();
      const added = new Set(hosts.map((h) => h.target));
      return {
        hosts: hosts.map(view),
        configHosts: configHostNames(deps.sshHostsFile).filter((n) => !added.has(n)),
      };
    },
    get: (id: string) => view(row(id)),
    // Add (Contracts 31.1): check at once, save only if reachable; 400 when unreachable, with ssh's stderr
    async add(target: string): Promise<SshHostView> {
      const existing = db.select().from(sshHosts).where(eq(sshHosts.target, target)).get();
      if (existing !== undefined) {
        throw new HttpError(409, `${target} is already added (${existing.label})`);
      }
      const result = await probe(target);
      if (!result.connected) throw new HttpError(400, result.error ?? `Cannot reach ${target}`);
      const id = newId('h');
      db.insert(sshHosts)
        .values({ id, target, label: target, check: result, checkedAt: new Date(result.at) })
        .run();
      events.publish({ type: 'ssh-hosts.updated' });
      return view(row(id));
    },
    rename(id: string, label: string): SshHostView {
      row(id);
      const trimmed = label.trim();
      if (trimmed === '') throw new HttpError(400, 'Name cannot be empty');
      db.update(sshHosts).set({ label: trimmed }).where(eq(sshHosts.id, id)).run();
      events.publish({ type: 'ssh-hosts.updated' });
      return view(row(id));
    },
    check,
    ready,
    known,
    async remove(id: string) {
      const r = row(id);
      if (running(id)) {
        throw new HttpError(
          409,
          `${r.label} has running interactions; end their processes before deleting it`,
        );
      }
      db.delete(sshHosts).where(eq(sshHosts.id, id)).run();
      await closeMaster(r.target);
      events.publish({ type: 'ssh-hosts.updated' });
    },
    // Subdirectories of a remote directory (Contracts 31.1): an empty dir means the remote HOME; fails with the output when missing
    async dirs(id: string, dir: string): Promise<DirList> {
      const r = row(id);
      const out = await sshScript(r.target, 'dirs.sh', [dir]);
      const [resolved = '', ...names] = out.split('\n');
      return {
        path: resolved,
        parent: resolved === '/' ? null : path.posix.dirname(resolved),
        dirs: names.filter((n) => n !== '').sort((a, b) => a.localeCompare(b)),
      };
    },
    // Create a folder in a remote directory (Contracts 34.1): only on this host, not recursive; 400 for an invalid name, 409 when it exists,
    // mkdir's output when it fails (e.g. no permission)
    async mkdir(id: string, parent: string, name: string): Promise<NewDir> {
      const r = row(id);
      const problem = folderNameProblem(name);
      if (problem !== null) throw new HttpError(400, problem);
      if (!path.posix.isAbsolute(parent)) {
        throw new HttpError(400, `The parent directory must be an absolute path: ${parent}`);
      }
      const result = await sshScriptResult(r.target, 'mkdir.sh', [parent, name]);
      if (result.exitCode === 255) throw new SshConnectError(r.target, result.stderr);
      if (result.exitCode === 3) throw new HttpError(409, existsMessage(result.stdout.trim()));
      if (result.exitCode !== 0) {
        throw new RemoteCommandError(r.target, result.exitCode, result.stdout, result.stderr);
      }
      return { path: result.stdout.trim() };
    },
    // Display name and target; null for a deleted host
    brief(id: string): { label: string; target: string } | null {
      return (
        db
          .select({ label: sshHosts.label, target: sshHosts.target })
          .from(sshHosts)
          .where(eq(sshHosts.id, id))
          .get() ?? null
      );
    },
    // Server shutdown: close every host's ControlMaster
    async shutdown() {
      const all = db.select({ target: sshHosts.target }).from(sshHosts).all();
      await Promise.all(all.map((h) => closeMaster(h.target)));
    },
  };
}

export type Hosts = ReturnType<typeof createHosts>;
