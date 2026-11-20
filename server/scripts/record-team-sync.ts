import fs from 'node:fs';
import path from 'node:path';
import { format, resolveConfig } from 'prettier';
import { TEAM_NOW } from '../test/helpers/team-replay.js';

// Record every gh call of a team fixture's first sync (Contracts 37.2: the linked PRs, the team's repos, the merged PR
// search up to TEAM_NOW, the PRs read to find GitHub logins) into test/fixtures/team/<name>/gh.json. The sync runs as
// team-stats.test.ts runs it, on the fixture's recorded Linear calls; test/fixtures/team/bin/gh replays what gh.json
// holds and runs the real gh for the rest. Only reads GitHub. Run by record-team-fixtures.ts after it records Linear;
// run alone (tsx scripts/record-team-sync.ts <name>) to add what a changed sync reads to an existing fixture
const [name] = process.argv.slice(2);
if (name === undefined) throw new Error('Usage: record-team-sync.ts <name>');
const fixtures = path.resolve(import.meta.dirname, '../test/fixtures/team');
const dir = path.join(fixtures, name);
const work = path.resolve(import.meta.dirname, '../../.work/record-team-sync', name);
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
const ghFile = path.join(dir, 'gh.json');
const record = path.join(work, 'gh.jsonl');
fs.writeFileSync(record, '');
process.env.WFD_LINEAR_MCP = JSON.stringify([
  process.execPath,
  path.join(fixtures, 'linear-stand-in.mjs'),
  path.join(dir, 'linear.json'),
]);
process.env.PATH = [path.join(fixtures, 'bin'), process.env.PATH].join(path.delimiter);
process.env.WFD_TEAM_GH_REPLAY = ghFile;
process.env.WFD_TEAM_GH_RECORD = record;

// config reads WFD_LINEAR_MCP when it is first imported
const { config } = await import('../src/config.js');
const { openDatabase } = await import('../src/db/index.js');
const { closeLinearClient } = await import('../src/external/linear.js');
const { createTeamSync } = await import('../src/team/sync.js');

const { scope } = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')) as {
  scope: Record<string, unknown>;
};
const db = openDatabase(path.join(work, 'db.sqlite'), config.migrationsDir);
const sync = createTeamSync({ db, team: 'TXE', scope, now: () => new Date(TEAM_NOW) });
const view = await sync.begin().done;
await closeLinearClient();
if (view.status !== 'succeeded')
  throw new Error(`${name} sync ${view.status}: ${String(view.error)}`);
const added = fs
  .readFileSync(record, 'utf8')
  .split('\n')
  .filter((l) => l !== '')
  .map((l) => JSON.parse(l) as unknown);
const gh = JSON.parse(fs.readFileSync(ghFile, 'utf8')) as { commands: unknown[] };
gh.commands.push(...added);
const options = await resolveConfig(ghFile);
fs.writeFileSync(ghFile, await format(JSON.stringify(gh), { ...options, filepath: ghFile }));
console.log(
  `${name}: ${String(added.length)} gh calls recorded, progress ${JSON.stringify(view.progress)}`,
);
