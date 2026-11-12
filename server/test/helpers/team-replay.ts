import fs from 'node:fs';
import path from 'node:path';

// Replays the recorded Linear and GitHub responses of test/fixtures/team/<name>/ for the Linear stats sync
// (Contracts 37.2): the Linear MCP connection becomes linear-stand-in.mjs and gh the replaying test/fixtures/team/bin/gh.
// Call before anything imports config (config reads WFD_LINEAR_MCP once, so this file does not import it either), then
// import the modules under test dynamically
const fixtures = path.resolve(import.meta.dirname, '../fixtures/team');
const work = path.resolve(import.meta.dirname, '../../../.work/test-team', String(process.pid));
const current = path.join(work, 'linear.json');
const linearLog = path.join(work, 'linear.log');
const ghLog = path.join(work, 'gh.log');

export interface TeamCall {
  name: string;
  args: Record<string, unknown>;
  isError: boolean;
  text: string;
}

export interface TeamMeta {
  scope: Record<string, unknown>;
  updatedAfter: string;
  issues: string[];
  updatedSince: string[];
  prs: string[];
}

export function teamReplay() {
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  process.env.WFD_LINEAR_MCP = JSON.stringify([
    process.execPath,
    path.join(fixtures, 'linear-stand-in.mjs'),
    current,
    '--log',
    linearLog,
  ]);
  process.env.PATH = [path.join(fixtures, 'bin'), process.env.PATH].join(path.delimiter);
  process.env.WFD_TEAM_GH_LOG = ghLog;
  const read = (file: string) =>
    fs.existsSync(file)
      ? fs
          .readFileSync(file, 'utf8')
          .split('\n')
          .filter((l) => l !== '')
          .map((l) => JSON.parse(l) as unknown)
      : [];
  return {
    meta(name: string): TeamMeta {
      return JSON.parse(
        fs.readFileSync(path.join(fixtures, name, 'meta.json'), 'utf8'),
      ) as TeamMeta;
    },
    // Replays fixture name; keep drops recorded calls (a call that then fails), delayMs slows every Linear call
    use(
      name: string,
      {
        keep = () => true,
        delayMs = 0,
      }: { keep?: (call: TeamCall) => boolean; delayMs?: number } = {},
    ) {
      const { calls } = JSON.parse(
        fs.readFileSync(path.join(fixtures, name, 'linear.json'), 'utf8'),
      ) as {
        calls: TeamCall[];
      };
      fs.writeFileSync(current, JSON.stringify({ delayMs, calls: calls.filter(keep) }));
      process.env.WFD_TEAM_GH_REPLAY = path.join(fixtures, name, 'gh.json');
      fs.rmSync(linearLog, { force: true });
      fs.rmSync(ghLog, { force: true });
    },
    // Identifiers read with get_issue since use(), in call order
    issuesRead(): string[] {
      return (read(linearLog) as { name: string; args: { id?: string } }[])
        .filter((c) => c.name === 'get_issue')
        .map((c) => c.args.id ?? '');
    },
    listings(): Record<string, unknown>[] {
      return (read(linearLog) as { name: string; args: Record<string, unknown> }[])
        .filter((c) => c.name === 'list_issues')
        .map((c) => c.args);
    },
    // PR API paths read with gh since use()
    prsRead(): string[] {
      return (read(ghLog) as string[][]).map((args) => args[1] ?? '');
    },
  };
}
