import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, test } from 'vitest';
import { config } from '../src/config.js';
import { type Db, openDatabase } from '../src/db/index.js';
import * as schema from '../src/db/schema.js';

const testDbDir = path.join(config.repoRoot, '.work', 'test-db');
const opened: { db: Db; file: string }[] = [];

function openTestDb() {
  const file = path.join(testDbDir, `${randomUUID()}.sqlite`);
  const db = openDatabase(file, config.migrationsDir);
  opened.push({ db, file });
  return db;
}

afterEach(() => {
  for (const { db, file } of opened.splice(0)) {
    db.$client.close();
    for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
  }
});

function seedRun(db: Db) {
  db.insert(schema.tasks)
    .values({
      id: 'calculator',
      kind: 'lfg',
      title: '做一个计算器',
      input: '我想要一个计算器',
      persona: '产品经理',
      hiddenRequirements: '支持括号',
      rubric: [
        {
          artifact: 'brief',
          items: [{ id: 'scope', criterion: '写明范围', maxScore: 5 }],
        },
      ],
      dir: '/tasks/calculator',
      contentHash: 'b'.repeat(64),
      updatedAt: new Date('2026-10-09T08:00:00Z'),
    })
    .run();
  db.insert(schema.variants)
    .values({
      id: 'baseline',
      name: 'baseline',
      baseCommit: '9f2bed6',
      skillsHash: 'a'.repeat(64),
      version: '2.3.0-eval.aaaaaaaa',
      model: 'opus',
      effort: 'high',
    })
    .run();
  db.insert(schema.batches).values({ id: 'batch-1', repeats: 1 }).run();
  db.insert(schema.batchTasks).values({ batchId: 'batch-1', taskId: 'calculator' }).run();
  db.insert(schema.batchVariants).values({ batchId: 'batch-1', variantId: 'baseline' }).run();
  db.insert(schema.runs)
    .values({
      id: 'run-1',
      batchId: 'batch-1',
      taskId: 'calculator',
      variantId: 'baseline',
      repeatIndex: 0,
      sessionId: 'session-1',
      workspacePath: '/workspace/run-1',
    })
    .run();
  db.insert(schema.sessions)
    .values({
      id: 'session-1',
      runId: 'run-1',
      filePath: '/projects/x/session-1.jsonl',
      startedAt: new Date('2026-10-09T08:00:00Z'),
      endedAt: new Date('2026-10-09T08:00:00Z'),
      parseState: { nextSeq: 0, lastUserAt: null, pending: {} },
    })
    .run();
}

function insertRequest(db: Db, sessionId: string, messageId: string) {
  return db
    .insert(schema.requests)
    .values({
      sessionId,
      messageId,
      seq: 0,
      timestamp: new Date('2026-10-09T08:00:00Z'),
      model: 'claude-opus-5-5',
      text: '你好',
      toolCalls: [
        {
          id: 'toolu_1',
          name: 'Read',
          input: { path: 'a' },
          result: 'b',
          resultChars: 1,
          isError: false,
          spillPath: null,
          subagentId: null,
        },
      ],
      inputTokens: 10,
      outputTokens: 20,
      cacheCreationTokens: 0,
      cacheReadTokens: 5,
      costUsd: 0.001,
    })
    .run();
}

describe('database', () => {
  test('迁移在真实 SQLite 文件上建出全部表', () => {
    const db = openTestDb();
    expect(existsSync(opened[0]?.file ?? '')).toBe(true);
    const tables = db.$client
      .prepare(
        "select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name not like '__drizzle%' order by name",
      )
      .pluck()
      .all();
    expect(tables).toEqual([
      'artifacts',
      'batch_tasks',
      'batch_variants',
      'batches',
      'grade_items',
      'grades',
      'requests',
      'run_messages',
      'runs',
      'sessions',
      'sources',
      'stage_analyses',
      'stage_checks',
      'stage_cycles',
      'stage_spans',
      'subagents',
      'tasks',
      'user_messages',
      'variants',
    ]);
  });

  test('写入后读回，json 与时间字段保持原值', () => {
    const db = openTestDb();
    seedRun(db);
    insertRequest(db, 'session-1', 'msg_1');

    const [request] = db
      .select()
      .from(schema.requests)
      .where(eq(schema.requests.sessionId, 'session-1'))
      .all();
    expect(request?.toolCalls[0]?.name).toBe('Read');
    expect(request?.timestamp.toISOString()).toBe('2026-10-09T08:00:00.000Z');

    const task = db.select().from(schema.tasks).where(eq(schema.tasks.id, 'calculator')).get();
    expect(task?.rubric?.[0]?.items[0]?.maxScore).toBe(5);
    expect(task?.createdAt).toBeInstanceOf(Date);

    const run = db.select().from(schema.runs).where(eq(schema.runs.id, 'run-1')).get();
    expect(run?.status).toBe('queued');
    expect(run?.humanIntervened).toBe(false);
  });

  test('同一 session 内 message.id 唯一', () => {
    const db = openTestDb();
    seedRun(db);
    insertRequest(db, 'session-1', 'msg_1');
    expect(() => insertRequest(db, 'session-1', 'msg_1')).toThrow(/UNIQUE constraint failed/);
  });

  test('外键生效：拒绝不存在的 session，删除 session 级联删除 requests', () => {
    const db = openTestDb();
    seedRun(db);
    expect(() => insertRequest(db, 'missing', 'msg_1')).toThrow(/FOREIGN KEY constraint failed/);

    insertRequest(db, 'session-1', 'msg_1');
    db.delete(schema.sessions).where(eq(schema.sessions.id, 'session-1')).run();
    expect(db.select().from(schema.requests).all()).toEqual([]);
  });

  test('被 run 引用的 variant 不能删除', () => {
    const db = openTestDb();
    seedRun(db);
    expect(() =>
      db.delete(schema.variants).where(eq(schema.variants.id, 'baseline')).run(),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});
