import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { sessionSkillLoads } from '../src/bindings/index.js';
import { config } from '../src/config.js';
import { type Db, openDatabase } from '../src/db/index.js';
import { requests, sessions, userMessages } from '../src/db/schema.js';
import { events } from '../src/events.js';
import { codexHomeOf, ingestCodexFile, readSessionMeta } from '../src/ingest/codex.js';
import { exportSessionRows } from '../src/insights/export.js';
import { readReport } from '../src/stages/report.js';
import { createVariants } from '../src/variants/index.js';
import { createWorkflows } from '../src/workflows/index.js';

// Contracts 25.2: importing a Codex rollout. The sample is a real rollout of a codex exec on this machine (29 lines, 3 requests; the exec script
// cats the history SKILL.md and calls two wf-history MCP tools), with the user name and the injected AGENTS.md removed
// (.work/w62/sanitize-rollout.mjs). Copied into a CODEX_HOME the test creates itself; the user's ~/.codex is never read or written
const fixture = path.join(
  import.meta.dirname,
  'fixtures/codex-rollouts/rollout-2026-10-04T20-22-00-01a106dd-2ba7-7e71-8490-0e170a634111.jsonl',
);
const sessionId = '01a106dd-2ba7-7e71-8490-0e170a634111';
// The only user input in the sample
const prompt =
  "Call the status tool of the wf-history MCP server, then its search tool with query 'wf install' and limit 1. Report the number of sources and whether search returned a hit.";
const work = path.join(config.repoRoot, '.work', 'test-ingest-codex', randomUUID());
const opened: Db[] = [];

afterAll(() => {
  for (const db of opened) db.$client.close();
  fs.rmSync(work, { recursive: true, force: true });
});

function openTestDb() {
  const db = openDatabase(path.join(work, `${randomUUID()}.sqlite`), config.migrationsDir);
  opened.push(db);
  return db;
}

// Copy the sample to <CODEX_HOME>/sessions/2026/10/04/
function copyRollout(content = fs.readFileSync(fixture, 'utf8')) {
  const file = path.join(work, randomUUID(), 'sessions/2026/10/04', path.basename(fixture));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

function snapshot(db: Db) {
  return {
    session: db
      .select({
        engine: sessions.engine,
        cwd: sessions.cwd,
        title: sessions.title,
        startedAt: sessions.startedAt,
        endedAt: sessions.endedAt,
      })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get(),
    requests: db
      .select()
      .from(requests)
      .where(eq(requests.sessionId, sessionId))
      .orderBy(asc(requests.seq))
      .all()
      // Autoincrement ids differ between databases; drop them for comparison
      .map((r) => ({ ...r, id: 0 })),
    users: db
      .select({ kind: userMessages.kind, text: userMessages.text })
      .from(userMessages)
      .where(eq(userMessages.sessionId, sessionId))
      .all(),
    skills: sessionSkillLoads(db, sessionId).map((s) => ({ ...s, id: 0 })),
  };
}

// The full history SKILL.md in the sample (the output of cat in the exec script)
function skillFile(): string {
  for (const line of fs.readFileSync(fixture, 'utf8').split('\n')) {
    if (!line.includes('"CommandExecution"')) continue;
    const record = JSON.parse(line) as {
      payload: { item: { aggregated_output: string; command: string[] } };
    };
    if (record.payload.item.command.at(-1)?.endsWith('history/SKILL.md') === true)
      return record.payload.item.aggregated_output;
  }
  throw new Error('The sample does not read the history SKILL.md');
}

describe('importing a Codex rollout', () => {
  const db = openTestDb();
  const file = copyRollout();
  ingestCodexFile(db, file);
  const snap = snapshot(db);

  test('session_meta: session id, working directory, start time; the title is the first user input', () => {
    expect(readSessionMeta(file)).toEqual({
      id: sessionId,
      cwd: '/Users/tester/install-test2/.install/codex-probe',
      startedAt: new Date('2026-10-04T12:22:00.364Z'),
    });
    expect(snap.session).toMatchObject({
      engine: 'codex',
      cwd: '/Users/tester/install-test2/.install/codex-probe',
    });
    expect(snap.session?.title).toBe(Array.from(prompt).slice(0, 80).join(''));
    // The injected AGENTS.md and environment notes are not user input
    expect(snap.users).toEqual([{ kind: 'user', text: prompt }]);
  });

  test('each token_usage_record is one request: model, tokens (input minus cache reads and writes); models missing from the price table record only tokens', () => {
    expect(snap.requests.map((r) => r.seq)).toEqual([0, 1, 2]);
    expect(snap.requests.map((r) => r.model)).toEqual([
      'gpt-6-astra',
      'gpt-6-astra',
      'gpt-6-astra',
    ]);
    expect(
      snap.requests.map((r) => [
        r.inputTokens,
        r.cacheReadTokens,
        r.cacheCreationTokens,
        r.outputTokens,
      ]),
    ).toEqual([
      [3, 0, 17966, 138],
      [3, 17966, 3770, 42],
      [3, 21736, 6936, 28],
    ]);
    expect(snap.requests.map((r) => r.costUsd)).toEqual([0, 0, 0]);
    expect(snap.requests[0]?.text).toBe(
      'I’ll use the history skill to check wf-history’s status and search for `wf install` with a limit of 1.\n',
    );
    expect(snap.requests[2]?.text).toBe(
      'Status reported **316 indexed sources**. Search for `wf install` with limit 1 returned **1 hit**.',
    );
  });

  test("tool calls: the model's exec call carries its output; commands and MCP tools run inside the exec script are recorded separately in the same request", () => {
    const calls = snap.requests.map((r) => r.toolCalls.map((c) => c.name));
    expect(calls).toEqual([
      ['exec', 'exec_command'],
      ['exec', 'mcp__wf-history__status', 'mcp__wf-history__search'],
      [],
    ]);
    const [exec, cat] = snap.requests[0]?.toolCalls ?? [];
    expect(exec?.result?.startsWith('Script completed')).toBe(true);
    expect(cat?.input).toEqual({
      cmd: 'cat /Users/tester/.codex/skills/history/SKILL.md',
      cwd: '/Users/tester/install-test2/.install/codex-probe',
    });
    expect(cat?.result).toBe(skillFile());
    expect(cat?.isError).toBe(false);
  });

  test('cat of a SKILL.md is a skill load: named after the directory, body without frontmatter', () => {
    expect(snap.skills).toMatchObject([
      {
        name: 'history',
        baseDir: '/Users/tester/.codex/skills/history',
        args: '',
      },
    ]);
    expect(skillFile().endsWith(snap.skills[0]?.text ?? '-')).toBe(true);
    expect(snap.skills[0]?.text.startsWith('---')).toBe(false);
  });

  test('importing again changes nothing; two incremental imports (cut at line N) equal one import', () => {
    expect(ingestCodexFile(db, file).changed).toBe(false);
    expect(snapshot(db)).toEqual(snap);
    const lines = fs.readFileSync(fixture, 'utf8').split('\n');
    for (const cut of [8, 14, 17, 20]) {
      const incremental = openTestDb();
      const partial = copyRollout(`${lines.slice(0, cut).join('\n')}\n`);
      ingestCodexFile(incremental, partial);
      fs.writeFileSync(partial, fs.readFileSync(fixture, 'utf8'));
      ingestCodexFile(incremental, partial);
      expect(snapshot(incremental), `cut at line ${String(cut)}`).toEqual(snap);
    }
  });

  // Each chunk is 1 byte longer than the longest line: when a line is longer than a chunk, that chunk reads to the end of the file (readCompleteLines)
  test('a chunked import (each chunk 1 byte longer than the longest line) equals one import', () => {
    const chunked = openTestDb();
    const copy = copyRollout();
    const longest = Math.max(
      ...fs
        .readFileSync(fixture, 'utf8')
        .split('\n')
        .map((l) => Buffer.byteLength(l)),
    );
    let passes = 0;
    for (let more = true; more; passes++) more = ingestCodexFile(chunked, copy, longest + 1).more;
    expect(passes).toBeGreaterThan(3);
    expect(snapshot(chunked)).toEqual(snap);
  });
});

describe('binding and stages of a Codex session', { timeout: 300_000 }, () => {
  test('auto-binds when the loaded skill matches the variant SKILL.md byte for byte, and splits stages by that workflow (cat of SKILL.md is the marker)', () => {
    const db = openTestDb();
    const variants = createVariants({
      db,
      dataDir: config.dataDir,
      repo: config.txeWorkflowRepo,
      ctxBin: config.ctxBin,
    });
    const workflows = createWorkflows({ db, variants });
    const id = `w62probe${randomUUID().slice(0, 6)}`;
    workflows.create({
      id,
      name: 'W62 probe',
      description: '',
      definition: { id, name: 'W62 probe', stages: [{ id: 'history' }] },
    });
    const variant = variants.list().find((v) => v.workflowId === id);
    if (variant === undefined) throw new Error(`${id} has no variant`);
    variants.writeFile(variant.id, 'skills/history/SKILL.md', skillFile());

    const file = copyRollout();
    ingestCodexFile(db, file);
    const session = db
      .select({ variantId: sessions.variantId, binding: sessions.variantBinding })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .get();
    expect(session).toEqual({ variantId: variant.id, binding: 'auto' });
    const report = readReport(db, sessionId);
    const stage = report?.workflows
      .find((w) => w.workflow === id)
      ?.cycles[0]?.stages.find((s) => s.stage === 'history');
    expect(stage).toMatchObject({
      status: 'active',
      startSeq: 0,
      evidence: { seq: 0, kind: 'skill', text: 'Skill: history' },
    });

    // The analysis export (Contracts 25.2): same format as a Claude Code session
    const exported = exportSessionRows(db, sessionId);
    expect(exported.rows.map((r) => [r.seq, r.agent, r.parentSeq, r.model])).toEqual([
      [0, null, 0, 'gpt-6-astra'],
      [1, null, 1, 'gpt-6-astra'],
      [2, null, 2, 'gpt-6-astra'],
    ]);
    for (const r of exported.rows) expect(r.stage).toMatch(new RegExp(`^${id}#\\d+ history$`));
    expect(exported.rows[0]?.userMessagesBefore).toEqual([{ kind: 'user', text: prompt }]);
    expect(exported.rows[0]?.skillLoads).toEqual([{ name: 'history', args: '' }]);
    expect(exported.rows[0]?.toolCalls[1]).toMatchObject({
      name: 'exec_command',
      result: skillFile(),
      spilledOutput: null,
    });
    expect(exported.rows.map((r) => r.thinking)).toEqual([null, null, null]);
    // The global AGENTS.md injected in the sample: under the CODEX_HOME holding this rollout
    expect(exported.instructions).toEqual([
      {
        timestamp: '2026-10-04T12:22:01.682Z',
        files: [
          {
            path: path.join(codexHomeOf(file), 'AGENTS.md'),
            type: 'User',
            content: 'Global instructions for this machine were removed from the test sample.',
          },
        ],
      },
    ]);
    fs.rmSync(variants.layout(variant.id).dir, { recursive: true, force: true });
  });
});

describe('analysis export of a Codex session', () => {
  // Two edits to the sample give two cases common in larger rollouts on this machine: the first exec output exceeds the stored length (truncated, read back verbatim on export),
  // and an encrypted-only reasoning block precedes the first request (reasoning_output_tokens 120)
  test('truncated tool results are read back verbatim from the rollout; the reasoning block is redacted_thinking with tokens from reasoning_output_tokens', () => {
    const long = `Script completed\n${'0123456789'.repeat(3000)}`;
    const lines = fs.readFileSync(fixture, 'utf8').trimEnd().split('\n');
    const changed = lines.flatMap((line, i) => {
      const record = JSON.parse(line) as {
        timestamp: string;
        type: string;
        payload: { type?: string; output?: unknown; usage?: Record<string, number> };
      };
      if (record.payload.type === 'custom_tool_call_output' && i < 17) {
        record.payload.output = long;
        return [JSON.stringify(record)];
      }
      if (record.type === 'token_usage_record' && i < 17) {
        const reasoning = {
          timestamp: record.timestamp,
          type: 'response_item',
          payload: { type: 'reasoning', summary: [], encrypted_content: 'gAAAA' },
        };
        record.payload.usage = { ...record.payload.usage, reasoning_output_tokens: 120 };
        return [JSON.stringify(reasoning), JSON.stringify(record)];
      }
      return [line];
    });
    const db = openTestDb();
    ingestCodexFile(db, copyRollout(`${changed.join('\n')}\n`));
    const first = db
      .select({ toolCalls: requests.toolCalls })
      .from(requests)
      .where(eq(requests.sessionId, sessionId))
      .orderBy(asc(requests.seq))
      .get();
    expect(first?.toolCalls[0]?.result?.length).toBeLessThan(long.length);

    const { rows } = exportSessionRows(db, sessionId);
    expect(rows[0]?.toolCalls[0]?.result).toBe(long);
    expect(rows.map((r) => r.thinking)).toEqual([
      [{ type: 'redacted_thinking', tokens: 120 }],
      null,
      null,
    ]);
  });
});

describe('session.updated for a Codex session', () => {
  test('a session created from only session_meta and task_started also publishes the event; nothing new publishes nothing', () => {
    const lines = fs.readFileSync(fixture, 'utf8').split('\n');
    const db = openTestDb();
    const file = copyRollout(`${lines.slice(0, 2).join('\n')}\n`);
    const published: unknown[] = [];
    const unsubscribe = events.subscribe((e) => published.push(e));
    expect(ingestCodexFile(db, file).changed).toBe(false);
    expect(snapshot(db).session?.engine).toBe('codex');
    expect(snapshot(db).requests).toEqual([]);
    expect(published).toEqual([{ type: 'session.updated', sessionId }]);
    ingestCodexFile(db, file);
    unsubscribe();
    expect(published).toHaveLength(1);
  });
});
