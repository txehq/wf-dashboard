import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { asc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, expect, test } from 'vitest';
import { z } from 'zod';
import { config } from '../../src/config.js';
import { openDatabase } from '../../src/db/index.js';
import { liveEvents, liveProcesses, liveSessions, sessions } from '../../src/db/schema.js';

// 迁移 0009（Contracts 14.1）：按旧结构（一次启动或 resume 一行）写入的数据库迁移后，同一个 claude_session_id 合并成一项，
// 原来每一行成为一个进程；resumed_from 指向已有一项的 resume 行并入那一项；事件、sessions.live_id 指向合并后的项
const work = path.join(config.repoRoot, '.work', 'test-migrations', randomUUID());
const dbFile = path.join(work, 'db.sqlite');

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

const Journal = z.looseObject({
  entries: z.array(z.looseObject({ idx: z.number(), tag: z.string() })),
});

// 只含 0000…0008 的迁移目录：建出交互旧结构的数据库
function migrationsBefore(tag: string): string {
  const dir = path.join(work, 'migrations');
  fs.cpSync(config.migrationsDir, dir, { recursive: true });
  const journalFile = path.join(dir, 'meta', '_journal.json');
  const journal = Journal.parse(JSON.parse(fs.readFileSync(journalFile, 'utf8')));
  const stop = journal.entries.findIndex((e) => e.tag === tag);
  if (stop < 0) throw new Error(`迁移 ${tag} 不在 journal 中`);
  for (const e of journal.entries.slice(stop)) fs.rmSync(path.join(dir, `${e.tag}.sql`));
  fs.writeFileSync(
    journalFile,
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, stop) }, null, 2),
  );
  return dir;
}

test('旧结构的交互记录合并成项与进程', () => {
  fs.mkdirSync(work, { recursive: true });
  // 旧结构的数据库只执行迁移：openDatabase 还会按当前结构写入内置的 workflow
  const old = new Database(dbFile);
  old.pragma('foreign_keys = ON');
  migrate(drizzle({ client: old }), { migrationsFolder: migrationsBefore('0009_live_items') });
  const run = (sql: string, ...params: unknown[]) => old.prepare(sql).run(...params);
  const t = (iso: string) => new Date(iso).getTime();
  // A：/lfg 新建后被 resume 两次（resume 行的 claude_session_id 与 resumed_from 都是 A 的 session）
  // B：从本机导入的 session X 第一次 resume（resumed_from 指向的 session 没有项），之后又 resume 一次
  // C：resumed_from 指向 A 的 session，但 claude_session_id 变了（/clear 之后的另一个 session），并入 A
  const insert = `insert into live_sessions (id, variant_id, environment, workflow, input, task_id, cwd,
    claude_session_id, resumed_from, pid, status, exit_code, error, driver, created_at, ended_at)
    values (?, null, ?, ?, ?, null, '/w', ?, ?, ?, 'exited', 0, ?, 'human', ?, ?)`;
  const input = '做一个计算器，支持加减乘除和括号的那种网页计算器';
  // id、environment、workflow、input、claude_session_id、resumed_from、pid、error、开始与结束的时刻（10 月 12 日）
  type Row = [
    string,
    string,
    string | null,
    string | null,
    string,
    string | null,
    number,
    string | null,
    string,
    string,
  ];
  const rows: Row[] = [
    ['l-20261012-aaaaaa', 'isolated', 'lfg', input, 'sa', null, 11, null, '01:00', '01:10'],
    ['l-20261012-aaaab1', 'real', null, null, 'sa', 'sa', 12, '服务重启中断', '02:00', '02:05'],
    ['l-20261012-bbbbb1', 'real', null, null, 'sx', 'sx', 21, null, '03:00', '03:01'],
    ['l-20261012-aaaab2', 'real', null, null, 'sa', 'sa', 13, null, '04:00', '04:30'],
    ['l-20261012-bbbbb2', 'real', null, null, 'sx', 'sx', 22, null, '05:00', '05:02'],
    ['l-20261012-cccccc', 'real', null, null, 'sc', 'sa', 31, null, '06:00', '06:20'],
  ];
  const at = (hm: string) => t(`2026-10-12T${hm}:00Z`);
  for (const [id, env, workflow, text, sid, from, pid, error, start, end] of rows) {
    run(insert, id, env, workflow, text, sid, from, pid, error, at(start), at(end));
  }
  const event = `insert into live_events (live_id, at, kind, payload) values (?, ?, ?, ?)`;
  const evs: [string, number, string, string][] = [
    ['l-20261012-aaaaaa', at('01:00'), 'start', '{"initial":"/lfg 做一个计算器"}'],
    ['l-20261012-aaaaaa', at('01:00') + 5000, 'hook', '{"hook_event_name":"SessionStart"}'],
    ['l-20261012-aaaab1', at('02:00'), 'start', '{"copiedFrom":null}'],
    ['l-20261012-bbbbb1', at('03:00'), 'start', '{"copiedFrom":"/x.jsonl"}'],
    ['l-20261012-cccccc', at('06:00'), 'start', '{}'],
    ['l-20261012-cccccc', at('06:20'), 'exit', '{"exitCode":0}'],
  ];
  for (const e of evs) run(event, ...e);
  const session = `insert into sessions (id, file_path, cwd, title, started_at, ended_at, parse_state, live_id)
    values (?, ?, '/w', ?, 0, 0, '{}', ?)`;
  run(session, 'sa', '/p/sa.jsonl', '/lfg 做一个计算器', 'l-20261012-aaaab2');
  run(session, 'sx', '/p/sx.jsonl', '帮我看看这个仓库的测试为什么失败', 'l-20261012-bbbbb2');
  run(session, 'sc', '/p/sc.jsonl', null, 'l-20261012-cccccc');
  run(session, 'so', '/p/so.jsonl', '不属于任何交互', null);
  old.close();

  const db = openDatabase(dbFile, config.migrationsDir);
  expect(db.select().from(liveSessions).orderBy(asc(liveSessions.id)).all()).toEqual([
    {
      id: 'l-20261012-aaaaaa',
      claudeSessionId: 'sa',
      // 输入的前 40 个字
      title: '/lfg 做一个计算器，支持加减乘除和括号的那种网页计算器'.slice(0, 40),
      environment: 'isolated',
      workflow: 'lfg',
      input: '做一个计算器，支持加减乘除和括号的那种网页计算器',
      taskId: null,
      cwd: '/w',
      createdAt: new Date('2026-10-12T01:00:00Z'),
      updatedAt: new Date('2026-10-12T06:20:00Z'),
    },
    {
      id: 'l-20261012-bbbbb1',
      claudeSessionId: 'sx',
      // 从已有 session 开始：取该 session 的标题
      title: '帮我看看这个仓库的测试为什么失败',
      environment: 'real',
      workflow: null,
      input: null,
      taskId: null,
      cwd: '/w',
      createdAt: new Date('2026-10-12T03:00:00Z'),
      updatedAt: new Date('2026-10-12T05:02:00Z'),
    },
  ]);
  const processes = db
    .select({
      id: liveProcesses.id,
      liveId: liveProcesses.liveId,
      kind: liveProcesses.kind,
      pid: liveProcesses.pid,
      error: liveProcesses.error,
      startedAt: liveProcesses.startedAt,
    })
    .from(liveProcesses)
    .orderBy(asc(liveProcesses.id))
    .all();
  expect(processes.map((p) => [p.liveId, p.kind, p.pid, p.error])).toEqual([
    ['l-20261012-aaaaaa', 'start', 11, null],
    ['l-20261012-aaaaaa', 'resume', 12, '服务重启中断'],
    ['l-20261012-bbbbb1', 'resume', 21, null],
    ['l-20261012-aaaaaa', 'resume', 13, null],
    ['l-20261012-bbbbb1', 'resume', 22, null],
    ['l-20261012-aaaaaa', 'resume', 31, null],
  ]);
  expect(processes[0]?.startedAt).toEqual(new Date('2026-10-12T01:00:00Z'));
  const processOf = (pid: number) => processes.find((p) => p.pid === pid)?.id;
  expect(
    db
      .select({ liveId: liveEvents.liveId, processId: liveEvents.processId, kind: liveEvents.kind })
      .from(liveEvents)
      .orderBy(asc(liveEvents.id))
      .all(),
  ).toEqual([
    { liveId: 'l-20261012-aaaaaa', processId: processOf(11), kind: 'start' },
    { liveId: 'l-20261012-aaaaaa', processId: processOf(11), kind: 'hook' },
    // resume 行的 start 事件改为 resume
    { liveId: 'l-20261012-aaaaaa', processId: processOf(12), kind: 'resume' },
    { liveId: 'l-20261012-bbbbb1', processId: processOf(21), kind: 'resume' },
    { liveId: 'l-20261012-aaaaaa', processId: processOf(31), kind: 'resume' },
    { liveId: 'l-20261012-aaaaaa', processId: processOf(31), kind: 'exit' },
  ]);
  const links = db
    .select({ id: sessions.id, liveId: sessions.liveId })
    .from(sessions)
    .orderBy(asc(sessions.id))
    .all();
  expect(links).toEqual([
    { id: 'sa', liveId: 'l-20261012-aaaaaa' },
    { id: 'sc', liveId: 'l-20261012-aaaaaa' },
    { id: 'so', liveId: null },
    { id: 'sx', liveId: 'l-20261012-bbbbb1' },
  ]);
  // 外键在提交时全部满足
  expect(db.$client.prepare('pragma foreign_key_check').all()).toEqual([]);
  // claude_session_id 唯一
  expect(() =>
    db
      .insert(liveSessions)
      .values({
        id: 'l-20261012-dddddd',
        claudeSessionId: 'sa',
        title: '重复',
        environment: 'real',
        cwd: '/w',
        updatedAt: new Date(),
      })
      .run(),
  ).toThrow(/UNIQUE constraint failed: live_sessions.claude_session_id/);
  expect(db.select().from(liveSessions).where(eq(liveSessions.id, 'l-20261012-cccccc')).get()).toBe(
    undefined,
  );
  db.$client.close();
});
