import { randomUUID } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../src/config.js';
import { type Db, openDatabase } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';
import { type AppEvent, events } from '../src/events.js';
import { ingestFile, truncateResult } from '../src/ingest/ingest.js';
import { sessionConversation } from '../src/ingest/conversation.js';
import { watchSession } from '../src/ingest/watch.js';
import { samplesDir } from './stages/samples.js';

// Real samples (test/fixtures/samples, unpacked to .work/samples).
// The two-step incremental cases import the whole file twice more: d93c4511 (2 MB, 3 subagents) and 9f4adf2d (4 MB, several subagents)
// already cover cuts through the main jsonl and subagents, so the 37 MB f0aca373 does not repeat it
const samples = [
  {
    slug: '-Users-linhaoz-Project-txe-txe-workflow',
    id: 'f0aca373-863f-4d62-babd-f48055092328',
    incremental: false,
  },
  {
    slug: '-Users-linhaoz-orca-projects-wf-dashboard',
    id: 'd93c4511-3c62-4b3b-8ee6-bf73370cd150',
    incremental: true,
  },
  {
    slug: '-Users-linhaoz-Project-txe-txe-workflow',
    id: '9f4adf2d-0730-4214-994a-4fba7f7b9161',
    incremental: true,
  },
];

const workDir = path.join(config.repoRoot, '.work', 'test-ingest', randomUUID());
const opened: Db[] = [];

function openTestDb() {
  const db = openDatabase(path.join(workDir, 'db', `${randomUUID()}.sqlite`), config.migrationsDir);
  opened.push(db);
  return db;
}

afterAll(() => {
  for (const db of opened) db.$client.close();
  rmSync(workDir, { recursive: true, force: true });
});

// Copy the sample under .work/; incremental tests rewrite its files
function copySample(sample: { slug: string; id: string }) {
  const target = path.join(workDir, randomUUID(), sample.slug);
  const source = path.join(samplesDir, sample.slug);
  cpSync(path.join(source, `${sample.id}.jsonl`), path.join(target, `${sample.id}.jsonl`));
  cpSync(path.join(source, sample.id), path.join(target, sample.id), { recursive: true });
  return path.join(target, `${sample.id}.jsonl`);
}

function subagentFiles(main: string) {
  const dir = path.join(main.replace(/\.jsonl$/, ''), 'subagents');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .map((f) => path.join(dir, f));
}

interface RawAssistant {
  type: 'assistant';
  message: {
    id: string;
    model: string;
    content: { type: string; id?: string }[];
    usage: {
      input_tokens: number;
      output_tokens: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
}

function assistantRecords(file: string): RawAssistant[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as { type: string })
    .filter((r): r is RawAssistant => r.type === 'assistant')
    .filter((r) => r.message.model !== '<synthetic>');
}

// Sum directly over the jsonl, deduplicated by message.id: each message takes the usage of its last record (the most complete when streamed)
function expectedOf(files: string[]) {
  let messages = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  const toolUseIds = new Set<string>();
  for (const file of files) {
    const usage = new Map<string, RawAssistant['message']['usage']>();
    for (const r of assistantRecords(file)) {
      usage.set(r.message.id, r.message.usage);
      for (const b of r.message.content) if (b.type === 'tool_use' && b.id) toolUseIds.add(b.id);
    }
    messages += usage.size;
    for (const u of usage.values()) {
      tokens.input += u.input_tokens;
      tokens.output += u.output_tokens;
      tokens.cacheRead += u.cache_read_input_tokens ?? 0;
      tokens.cacheCreation += u.cache_creation_input_tokens ?? 0;
    }
  }
  return { messages, tokens, toolUseIds };
}

// Everything imported for a session (autoincrement ids and write times cleared)
function snapshot(db: Db, sessionId: string) {
  const session = db.select().from(schema.sessions).where(eq(schema.sessions.id, sessionId)).get();
  if (session === undefined) throw new Error(`Session ${sessionId} not imported`);
  return {
    session: { ...session, createdAt: null },
    requests: db
      .select()
      .from(schema.requests)
      .where(eq(schema.requests.sessionId, sessionId))
      .orderBy(asc(schema.requests.agentId), asc(schema.requests.seq))
      .all()
      .map((r) => ({ ...r, id: null })),
    userMessages: db
      .select()
      .from(schema.userMessages)
      .where(eq(schema.userMessages.sessionId, sessionId))
      .orderBy(asc(schema.userMessages.agentId), asc(schema.userMessages.uuid))
      .all()
      .map((m) => ({ ...m, id: null })),
    subagents: db
      .select()
      .from(schema.subagents)
      .where(eq(schema.subagents.sessionId, sessionId))
      .orderBy(asc(schema.subagents.agentId))
      .all(),
  };
}

// The cut falls between two records of the same message and truncates the next line midway, covering "a message across two reads" and "half a line"
function splitPoint(file: string) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const ids = lines.map((l) => {
    if (l.length === 0) return null;
    const r = JSON.parse(l) as { type: string; message?: { id?: string } };
    return r.type === 'assistant' ? (r.message?.id ?? null) : null;
  });
  const middle = Math.floor(lines.length / 2);
  for (let i = middle; i < lines.length; i++)
    if (ids[i] !== null && ids[i] === ids[i - 1]) return { lines, at: i };
  throw new Error(`${file} has no message spanning two lines after its midpoint`);
}

function writePrefix(file: string, lines: string[], at: number) {
  const next = lines[at] ?? '';
  writeFileSync(
    file,
    `${lines.slice(0, at).join('\n')}\n${next.slice(0, Math.floor(next.length / 2))}`,
  );
}

describe('watchSession', () => {
  test('imports incrementally after appends and publishes session.updated', async () => {
    const sample = samples[1];
    if (sample === undefined) throw new Error('Missing sample');
    const db = openTestDb();
    const watched = copySample(sample);
    const full = readFileSync(watched, 'utf8');
    const { lines, at } = splitPoint(watched);
    writePrefix(watched, lines, at);
    const errors: Error[] = [];
    const watcher = watchSession(db, watched, (error) => errors.push(error));
    const before = snapshot(db, sample.id).requests.length;

    const updated = new Promise<void>((resolve) => {
      const unsubscribe = events.subscribe((e) => {
        if (
          e.type === 'session.updated' &&
          e.sessionId === sample.id &&
          snapshot(db, sample.id).session.parseOffset === Buffer.byteLength(full)
        ) {
          unsubscribe();
          resolve();
        }
      });
    });
    appendFileSync(watched, full.slice(readFileSync(watched, 'utf8').length));
    await updated;
    await watcher.close();
    expect(errors).toEqual([]);

    // A single import of the same file as reference
    const reference = openTestDb();
    ingestFile(reference, watched);
    const expected = snapshot(reference, sample.id);
    expect(before).toBeLessThan(expected.requests.length);
    expect(snapshot(db, sample.id)).toEqual(expected);
  });
});

describe.each(samples)('ingest $id', (sample) => {
  const db = openTestDb();
  const main = copySample(sample);
  const subs = subagentFiles(main);
  const published: AppEvent[] = [];
  const unsubscribe = events.subscribe((e) => published.push(e));
  const result = ingestFile(db, main);
  unsubscribe();
  const snap = snapshot(db, sample.id);
  const expected = expectedOf([main, ...subs]);

  test('request rows equal the deduplicated message.id count', () => {
    expect(result.changed).toBe(true);
    expect(snap.requests.length).toBe(expected.messages);
    expect(snap.requests.length).toBeGreaterThan(0);
  });

  test('token totals match a direct sum deduplicated by message.id', () => {
    const sum = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
    for (const r of snap.requests) {
      sum.input += r.inputTokens;
      sum.output += r.outputTokens;
      sum.cacheRead += r.cacheReadTokens;
      sum.cacheCreation += r.cacheCreationTokens;
    }
    expect(sum).toEqual(expected.tokens);
    expect(snap.requests.every((r) => r.costUsd > 0)).toBe(true);
  });

  test('every tool_use is paired with its result', () => {
    const calls = snap.requests.flatMap((r) => r.toolCalls);
    expect(new Set(calls.map((c) => c.id))).toEqual(expected.toolUseIds);
    expect(calls.filter((c) => c.result === null)).toEqual([]);
    for (const c of calls) {
      expect(c.resultChars).toBeGreaterThanOrEqual(c.result?.length ?? 0);
      expect(c.result?.length).toBeLessThanOrEqual(20_000);
    }
    expect(snap.session.parseState.pending).toEqual({});
  });

  test('subagents are linked to the parent ToolCall', () => {
    expect(snap.subagents.length).toBe(subs.length);
    const calls = snap.requests.filter((r) => r.agentId === null).flatMap((r) => r.toolCalls);
    for (const sub of snap.subagents) {
      const meta = JSON.parse(
        readFileSync(sub.filePath.replace(/\.jsonl$/, '.meta.json'), 'utf8'),
      ) as { toolUseId: string };
      expect(sub.parentToolUseId).toBe(meta.toolUseId);
      const parent = calls.find((c) => c.id === meta.toolUseId);
      expect(parent?.subagentId).toBe(sub.agentId);
      // An interrupted subagent may have no model requests; check against each file's deduplicated message count
      expect(snap.requests.filter((r) => r.agentId === sub.agentId).length).toBe(
        expectedOf([sub.filePath]).messages,
      );
    }
    expect(calls.filter((c) => c.subagentId !== null).length).toBe(subs.length);
  });

  test('results spilled to tool-results/ record the local path', () => {
    const spilled = snap.requests.flatMap((r) => r.toolCalls).filter((c) => c.spillPath !== null);
    const raw = [main, ...subs].map((f) => readFileSync(f, 'utf8')).join('\n');
    expect(spilled.length).toBe(raw.split('"content":"<persisted-output>').length - 1);
    for (const c of spilled) {
      expect(c.result?.startsWith('<persisted-output>')).toBe(true);
      expect(path.dirname(c.spillPath ?? '')).toBe(
        path.join(path.dirname(main), sample.id, 'tool-results'),
      );
      expect(existsSync(c.spillPath ?? '')).toBe(true);
    }
  });

  test('background task notifications, local command output and messages from other sessions are notices, never the title', () => {
    const expectedNotices = [main, ...subs].flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => l.length > 0)
        .map(
          (l) =>
            JSON.parse(l) as {
              type: string;
              uuid?: string;
              isMeta?: boolean;
              origin?: { kind: string } | null;
              message?: { content: string | { type: string; text?: string }[] };
            },
        )
        .filter((r) => r.type === 'user' && (r.isMeta !== true || r.origin?.kind === 'peer'))
        .filter((r) => {
          const c = r.message?.content;
          const text =
            typeof c === 'string'
              ? c
              : (c ?? [])
                  .filter((b) => b.type === 'text')
                  .map((b) => b.text)
                  .join('\n');
          return (
            r.origin?.kind === 'task-notification' ||
            r.origin?.kind === 'peer' ||
            text.startsWith('<local-command-stdout>')
          );
        })
        .map((r) => r.uuid),
    );
    const notices = snap.userMessages.filter((m) => m.kind === 'notice');
    expect(notices.map((m) => m.uuid).sort()).toEqual(expectedNotices.sort());
    expect(snap.userMessages.some((m) => m.kind === 'user')).toBe(true);
    const firstUser = snap.userMessages
      .filter((m) => m.kind === 'user' && m.agentId === null)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime())[0];
    if (snap.session.title !== null) {
      expect(firstUser?.text.replace(/\s+/g, ' ').trim().startsWith(snap.session.title)).toBe(true);
      expect(snap.session.title.startsWith('<task-notification>')).toBe(false);
    }
  });

  test('publishes session.updated; importing again changes nothing', () => {
    expect(published).toContainEqual({ type: 'session.updated', sessionId: sample.id });
    expect(ingestFile(db, main).changed).toBe(false);
    expect(snapshot(db, sample.id)).toEqual(snap);
  });

  test.runIf(sample.incremental)(
    'importing the first N lines and the rest incrementally equals one import',
    () => {
      const incremental = openTestDb();
      const full = readFileSync(main, 'utf8');
      const { lines, at } = splitPoint(main);
      const subFull = subs.map((f) => readFileSync(f, 'utf8'));
      writePrefix(main, lines, at);
      subs.forEach((f, i) => {
        const subLines = (subFull[i] ?? '').split('\n');
        writePrefix(f, subLines, Math.floor(subLines.length / 2));
      });
      expect(ingestFile(incremental, main).changed).toBe(true);
      const partial = snapshot(incremental, sample.id);
      expect(partial.requests.length).toBeLessThan(snap.requests.length);

      writeFileSync(main, full);
      subs.forEach((f, i) => {
        writeFileSync(f, subFull[i] ?? '');
      });
      expect(ingestFile(incremental, main).changed).toBe(true);
      expect(snapshot(incremental, sample.id)).toEqual(snap);
    },
  );

  // Imports read in chunks (importFiles and incremental import): 256 KB each, stopping at the previous newline when a chunk boundary falls inside a line
  test.runIf(sample.incremental)('a chunked import (256 KB chunks) equals one import', () => {
    const chunked = openTestDb();
    let passes = 0;
    for (let more = true; more; passes++) more = ingestFile(chunked, main, 256 * 1024).more;
    expect(passes).toBeGreaterThan(4);
    expect(snapshot(chunked, sample.id)).toEqual(snap);
  });
});

// A fork subagent's (meta isFork) jsonl starts with a copy of the parent conversation, up to the tool_result of the Agent call that spawned it
const forkSample = {
  slug: '-Users-linhaoz-Project-txe-txe-workflow',
  id: 'd70a6a0e-ddef-4989-8f2a-f2a5adea7abd',
};

interface ForkMeta {
  isFork?: boolean;
  toolUseId: string;
  parentAgentId?: string;
}

// The fork's own part: message.id and tool_use.id after the spawning call's tool_result
function forkOwn(file: string, meta: ForkMeta) {
  const records = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0)
    .map(
      (l) =>
        JSON.parse(l) as {
          type: string;
          message?: { id?: string; model?: string; content?: unknown };
        },
    );
  const start = records.findIndex(
    (r) =>
      r.type === 'user' &&
      Array.isArray(r.message?.content) &&
      (r.message.content as { type: string; tool_use_id?: string }[]).some(
        (b) => b.type === 'tool_result' && b.tool_use_id === meta.toolUseId,
      ),
  );
  expect(start).toBeGreaterThan(0);
  const own = new Set<string>();
  for (const r of records.slice(start + 1))
    if (r.type === 'assistant' && r.message?.model !== '<synthetic>' && r.message?.id)
      own.add(r.message.id);
  return { messages: own, inherited: start };
}

describe('ingest fork subagents', () => {
  const db = openTestDb();
  const main = copySample(forkSample);
  ingestFile(db, main);
  const snap = snapshot(db, forkSample.id);
  const forks = snap.subagents
    .map((s) => ({
      sub: s,
      meta: JSON.parse(
        readFileSync(s.filePath.replace(/\.jsonl$/, '.meta.json'), 'utf8'),
      ) as ForkMeta,
    }))
    .filter((f) => f.meta.isFork === true);

  test('no duplicate tool calls within a row; each message.id belongs to one agent', () => {
    expect(forks).toHaveLength(3);
    for (const r of snap.requests) {
      const ids = r.toolCalls.map((c) => c.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
    const ids = snap.requests.map((r) => r.messageId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('fork requests are their own rows with seq from 0; inherited parent records are not imported', () => {
    for (const { sub, meta } of forks) {
      const rows = snap.requests.filter((r) => r.agentId === sub.agentId);
      const own = forkOwn(sub.filePath, meta);
      expect(rows.map((r) => r.messageId).sort()).toEqual([...own.messages].sort());
      expect(rows.map((r) => r.seq)).toEqual(rows.map((_, i) => i));
      expect(rows.flatMap((r) => r.toolCalls).filter((c) => c.result === null)).toEqual([]);
      expect(sub.parseState.pending).toEqual({});
      expect(sub.parseState.forkToolUseId).toBeUndefined();
      // The fork's only user message is the fork instruction from spawning
      const messages = snap.userMessages.filter((m) => m.agentId === sub.agentId);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.text.startsWith('<fork-boilerplate>')).toBe(true);
    }
  });

  test('the parent agent rows match its jsonl; the Agent calls spawning forks point to the forks', () => {
    const parentId = forks[0]?.meta.parentAgentId;
    const parent = snap.subagents.find((s) => s.agentId === parentId);
    if (parent === undefined) throw new Error(`No parent agent ${String(parentId)}`);
    const expected = expectedOf([parent.filePath]);
    const rows = snap.requests.filter((r) => r.agentId === parent.agentId);
    expect(rows).toHaveLength(expected.messages);
    expect(new Set(rows.flatMap((r) => r.toolCalls.map((c) => c.id)))).toEqual(expected.toolUseIds);
    const calls = rows.flatMap((r) => r.toolCalls);
    for (const { sub, meta } of forks)
      expect(calls.find((c) => c.id === meta.toolUseId)?.subagentId).toBe(sub.agentId);
  });

  test('fork files cut inside the inherited part and imported in two steps equal one import', () => {
    const incremental = openTestDb();
    const contents = forks.map(({ sub }) => readFileSync(sub.filePath, 'utf8'));
    const cuts = forks.map(({ sub, meta }) =>
      Math.floor(forkOwn(sub.filePath, meta).inherited / 2),
    );
    forks.forEach(({ sub }, i) => {
      writePrefix(sub.filePath, (contents[i] ?? '').split('\n'), cuts[i] ?? 0);
    });
    ingestFile(incremental, main);
    const partial = snapshot(incremental, forkSample.id);
    for (const { sub } of forks)
      expect(partial.requests.filter((r) => r.agentId === sub.agentId)).toEqual([]);
    forks.forEach(({ sub }, i) => {
      writeFileSync(sub.filePath, contents[i] ?? '');
    });
    expect(ingestFile(incremental, main).changed).toBe(true);
    expect(snapshot(incremental, forkSample.id)).toEqual(snap);
  });
});

// W15 Low 17: truncating by UTF-16 units used to leave half a surrogate pair
test('tool result truncation does not split a surrogate pair', () => {
  const emoji = '😀';
  const text = `${'a'.repeat(19_999)}${emoji}b`;
  const cut = truncateResult(text);
  expect(cut).toBe('a'.repeat(19_999));
  expect(truncateResult(`${'a'.repeat(19_998)}${emoji}b`)).toBe(`${'a'.repeat(19_998)}${emoji}`);
  expect(truncateResult('short')).toBe('short');
});

// W15 Medium 1: a peer message from another Claude session (origin.kind peer, isMeta) starts a turn;
// the trigger time used not to be updated, so the next request's duration_ms was empty or counted from a user message hours earlier
describe('peer messages', () => {
  test('a peer message is returned as a notice keeping the sender; the next request is timed from it', () => {
    const db = openTestDb();
    const id = 'b7199c56-42d6-4dda-ac96-117d3937ebdd';
    ingestFile(db, path.join(import.meta.dirname, 'fixtures/peer', `${id}.jsonl`));
    const first = db
      .select()
      .from(schema.requests)
      .where(eq(schema.requests.sessionId, id))
      .orderBy(asc(schema.requests.seq))
      .get();
    expect(first?.seq).toBe(0);
    expect(first?.durationMs).toBe(
      Date.parse('2026-09-25T09:20:33.252Z') - Date.parse('2026-09-25T09:20:28.098Z'),
    );
    const messages = db
      .select()
      .from(schema.userMessages)
      .where(eq(schema.userMessages.sessionId, id))
      .all();
    // Contracts 2: a peer message is returned as a notice keeping the sender; it is not a user message and does not feed the title
    const peer = messages.filter((m) => m.text.includes('cross-session-message'));
    expect(peer.map((m) => m.kind)).toEqual(['notice']);
    expect(peer[0]?.text).toContain('from-name="hi-46"');
    const session = db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
    expect(session?.title ?? '').not.toContain('cross-session-message');
    // The conversation view shows it as a notice too
    const conversation = sessionConversation(db, id) ?? [];
    const item = conversation.find((c) => c.kind !== 'question' && c.text.includes('hi-46'));
    expect(item?.kind).toBe('notice');
    expect(conversation.filter((c) => c.kind === 'user')).toEqual([]);
  });
});
