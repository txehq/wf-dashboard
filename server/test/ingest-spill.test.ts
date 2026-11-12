import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, expect, test } from 'vitest';
import { config } from '../src/config.js';
import { type Db, openDatabase } from '../src/db/index.js';
import { requests } from '../src/db/schema.js';
import { importProblemOf } from '../src/ingest/import-problems.js';
import { ingestFile } from '../src/ingest/ingest.js';

// Recognising spilled output (W63); fixtures/spill/ holds lines from real sessions (/Users/<user> replaced):
// - real: a spill Claude Code really wrote, the path under this session's own <sessionId>/tool-results/, with the spill file beside it;
// - quoted: an analysis session reads another session's exported records with jq, and the Bash output starts with that session's <persisted-output>
//   (one cut by jq at 150 characters, the path only up to variants/80ef1f07; one complete, pointing at another session's tool-results/); not spills
const fixtures = path.join(import.meta.dirname, 'fixtures', 'spill');
const workDir = path.join(config.repoRoot, '.work', 'test-ingest-spill', randomUUID());
const opened: Db[] = [];

afterAll(() => {
  for (const db of opened) db.$client.close();
  rmSync(workDir, { recursive: true, force: true });
});

// Import a copy under .work/; returns all tool calls of the session
function ingestCopy(name: string, sessionId: string, keepSpills = true) {
  const dir = path.join(workDir, randomUUID());
  cpSync(path.join(fixtures, name), dir, { recursive: true });
  if (!keepSpills) rmSync(path.join(dir, sessionId), { recursive: true, force: true });
  const db = openDatabase(path.join(dir, 'db.sqlite'), config.migrationsDir);
  opened.push(db);
  const file = path.join(dir, `${sessionId}.jsonl`);
  ingestFile(db, file);
  const calls = db
    .select()
    .from(requests)
    .where(eq(requests.sessionId, sessionId))
    .all()
    .flatMap((r) => r.toolCalls);
  return { dir, calls };
}

test('a spill Claude Code wrote: spillPath points to the local file under <sessionId>/tool-results/', () => {
  const id = 'f3488cd1-1371-4b5f-96e9-bb71b156bd03';
  const { dir, calls } = ingestCopy('real', id);
  const spilled = calls.filter((c) => c.spillPath !== null);
  expect(spilled).toHaveLength(1);
  expect(spilled[0]?.result?.startsWith('<persisted-output>')).toBe(true);
  expect(spilled[0]?.spillPath).toBe(path.join(dir, id, 'tool-results', 'bobyx4l87.txt'));
  expect(existsSync(spilled[0]?.spillPath ?? '')).toBe(true);
});

test('a real spill not yet present: the import stops before the line referencing it and records the wait, then continues once the file appears', () => {
  const id = 'f3488cd1-1371-4b5f-96e9-bb71b156bd03';
  const { dir, calls } = ingestCopy('real', id, false);
  const spill = path.join(dir, id, 'tool-results', 'bobyx4l87.txt');
  // The first line (tool_use) is imported, the second (its result) waits for next time
  expect(calls).toHaveLength(1);
  expect(calls[0]?.result).toBeNull();
  expect(importProblemOf(id)).toMatchObject({ kind: 'waiting' });
  expect(importProblemOf(id)?.message).toContain(spill);
  const db = opened.at(-1);
  if (db === undefined) throw new Error('No open database');
  cpSync(path.join(fixtures, 'real', id), path.join(dir, id), { recursive: true });
  ingestFile(db, path.join(dir, `${id}.jsonl`));
  const after = db
    .select()
    .from(requests)
    .where(eq(requests.sessionId, id))
    .all()
    .flatMap((r) => r.toolCalls);
  expect(after).toHaveLength(1);
  expect(after[0]?.spillPath).toBe(spill);
  expect(after[0]?.result?.startsWith('<persisted-output>')).toBe(true);
  expect(importProblemOf(id)).toBeNull();
});

test('a spill notice of another session quoted in tool output is not a spill: imported as usual, the result kept verbatim', () => {
  const id = '70f4ffbe-67e0-43a9-b99e-7e426beb0f9b';
  const { calls } = ingestCopy('quoted', id);
  const quoted = calls.filter((c) => c.result?.startsWith('<persisted-output>') === true);
  expect(quoted).toHaveLength(2);
  for (const c of quoted) expect(c.spillPath).toBeNull();
  // The one cut by jq: the path stops at variants/80ef1f07, so the file name taken before was 80ef1f07
  expect(quoted.some((c) => c.result?.includes('data-ic/variants/80ef1f07\n') === true)).toBe(true);
});
