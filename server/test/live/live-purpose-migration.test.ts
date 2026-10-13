import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { asc } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, expect, test } from 'vitest';
import { z } from 'zod';
import { config } from '../../src/config.js';
import { openDatabase } from '../../src/db/index.js';
import { liveSessions } from '../../src/db/schema.js';

// 迁移 0018（Contracts 14.3）：live_sessions.purpose 按已有记录推出。有 optimize 草稿的项为 optimize，
// 有 workflow 或 variant 草稿的项为 design，其余为 interaction；有草稿的项的 engine 为 codex
const work = path.join(config.repoRoot, '.work', 'test-migrations', randomUUID());
const dbFile = path.join(work, 'db.sqlite');

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

const Journal = z.looseObject({
  entries: z.array(z.looseObject({ idx: z.number(), tag: z.string() })),
});

// 只含 tag 之前各迁移的目录
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

test('普通项、设计草稿的项、优化的项迁移后用途与引擎正确', () => {
  fs.mkdirSync(work, { recursive: true });
  // 旧结构的数据库只执行迁移：openDatabase 还会按当前结构写入内置的 workflow
  const old = new Database(dbFile);
  old.pragma('foreign_keys = ON');
  migrate(drizzle({ client: old }), { migrationsFolder: migrationsBefore('0018_live-purpose') });
  const item = old.prepare(
    `insert into live_sessions (id, claude_session_id, engine, title, environment, cwd, updated_at)
     values (?, ?, ?, ?, ?, '/w', 0)`,
  );
  item.run('l-20261013-plain1', 'sa', 'claude', '/lfg 做一个计算器', 'real');
  item.run('l-20261013-imprt1', 'sb', 'claude', '导入的 session', 'real');
  item.run('l-20261013-dsgnwf', 'cx-1', 'codex', 'Codex：新 workflow hello', 'isolated');
  item.run('l-20261013-dsgnvr', null, 'codex', 'Codex：lfg 的新 variant', 'isolated');
  // 旧数据中 engine 没有写对的 Codex 项：按草稿改为 codex
  item.run('l-20261013-optmz1', 'cx-2', 'claude', 'Codex：优化 lfg（分析 a-1）', 'isolated');
  const draft = old.prepare(
    `insert into workflow_drafts (id, mode, workflow_id, requirement, live_id) values (?, ?, ?, '需求', ?)`,
  );
  draft.run('d-20261013-aaaaaa', 'workflow', 'hello', 'l-20261013-dsgnwf');
  draft.run('d-20261013-bbbbbb', 'variant', 'lfg', 'l-20261013-dsgnvr');
  draft.run('d-20261013-cccccc', 'optimize', 'lfg', 'l-20261013-optmz1');
  // 删除交互项后草稿的 live_id 为空：不影响任何项
  draft.run('d-20261013-dddddd', 'variant', 'lfg', null);
  old.close();

  const db = openDatabase(dbFile, config.migrationsDir);
  expect(
    db
      .select({ id: liveSessions.id, purpose: liveSessions.purpose, engine: liveSessions.engine })
      .from(liveSessions)
      .orderBy(asc(liveSessions.id))
      .all(),
  ).toEqual([
    { id: 'l-20261013-dsgnvr', purpose: 'design', engine: 'codex' },
    { id: 'l-20261013-dsgnwf', purpose: 'design', engine: 'codex' },
    { id: 'l-20261013-imprt1', purpose: 'interaction', engine: 'claude' },
    { id: 'l-20261013-optmz1', purpose: 'optimize', engine: 'codex' },
    { id: 'l-20261013-plain1', purpose: 'interaction', engine: 'claude' },
  ]);
  db.$client.close();
});
