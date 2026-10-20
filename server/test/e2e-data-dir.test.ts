import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { migrationDifferences, resetOnMigrationChange } from '../scripts/e2e-data-dir.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { sessions } from '../src/db/schema.js';
import { tailSessions } from '../src/ingest/session-import.js';
import { importFiles } from '../src/ingest/sources.js';
import { testSourceDirs } from './helpers/source-dirs.js';

// prepare-runs-e2e 的数据目录在多次运行之间保留：同一个 worktree 先用分支的迁移跑过，再换成 main 的迁移。
// 仓库现有 n 个迁移：分支上的第 n 个 note 在 main 中重新生成为第 n + 1 个（时间更晚），main 的第 n 个是 other
const work = path.join(config.repoRoot, '.work', 'test-e2e-data-dir', randomUUID());
const repoJournal = path.join(config.migrationsDir, 'meta', '_journal.json');
const repoEntries = (
  JSON.parse(fs.readFileSync(repoJournal, 'utf8')) as { entries: { when: number }[] }
).entries;
const lastWhen = Math.max(...repoEntries.map((e) => e.when));
const n = repoEntries.length;
// drizzle 的迁移名：四位编号加名字
const tagOf = (idx: number, name: string) => `${String(idx).padStart(4, '0')}_${name}`;
const branchNote = tagOf(n, 'note');
const mainOther = tagOf(n, 'other');
const mainNote = tagOf(n + 1, 'note');
const noteSql = 'ALTER TABLE `runs` ADD `w66_note` text;';
const otherSql = 'CREATE TABLE `w66_other` (`id` integer PRIMARY KEY NOT NULL);';

// 仓库的迁移加上几个新迁移，写成另一个迁移目录
function migrations(name: string, added: { tag: string; when: number; sql: string }[]) {
  const dir = path.join(work, name);
  fs.cpSync(config.migrationsDir, dir, { recursive: true });
  const journalFile = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as {
    entries: { idx: number; version: string; when: number; tag: string; breakpoints: boolean }[];
  };
  for (const m of added) {
    fs.writeFileSync(path.join(dir, `${m.tag}.sql`), m.sql);
    journal.entries.push({
      idx: journal.entries.length,
      version: '6',
      when: m.when,
      tag: m.tag,
      breakpoints: true,
    });
  }
  fs.writeFileSync(journalFile, JSON.stringify(journal, null, 2));
  return dir;
}

const branch = migrations('branch', [{ tag: branchNote, when: lastWhen + 1000, sql: noteSql }]);
const main = migrations('main', [
  { tag: mainOther, when: lastWhen + 2000, sql: otherSql },
  { tag: mainNote, when: lastWhen + 3000, sql: noteSql },
]);

// 一个数据目录：用分支的迁移建好数据库；variants/ 下有一个 variant 的 home，其中有 resume 时复制的 session，
// 原文件在来源目录中（真实的小 session f3488cd1）
const sessionId = 'f3488cd1-1371-4b5f-96e9-bb71b156bd03';
const fixture = path.join(import.meta.dirname, 'fixtures/spill/real');
function branchDataDir(name: string) {
  const dataDir = path.join(work, name);
  const dbPath = path.join(dataDir, 'db.sqlite');
  openDatabase(dbPath, branch).$client.close();
  const projectsDir = path.join(work, `${name}-projects`);
  const slug = path.join(projectsDir, '-Users-test-project');
  const copy = path.join(dataDir, 'variants', randomUUID(), 'home/claude/projects/l-20261014-w66');
  for (const dir of [slug, copy]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(fixture, `${sessionId}.jsonl`), path.join(dir, `${sessionId}.jsonl`));
    fs.cpSync(path.join(fixture, sessionId), path.join(dir, sessionId), { recursive: true });
  }
  return {
    dataDir,
    dbPath,
    dirs: testSourceDirs(dataDir, { projectsDir, variantsDir: path.join(dataDir, 'variants') }),
    slug,
  };
}

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

describe('prepare-runs-e2e 保留的数据目录', () => {
  test('迁移一致时没有差别，没有数据库时也没有', () => {
    const dbPath = path.join(work, 'same', 'db.sqlite');
    expect(migrationDifferences(dbPath, branch)).toEqual([]);
    openDatabase(dbPath, branch).$client.close();
    expect(migrationDifferences(dbPath, branch)).toEqual([]);
  });

  test('不比较时，分支的迁移跑过后换成 main 的迁移出现 duplicate column name', () => {
    const { dbPath } = branchDataDir('unchecked');
    // drizzle 把 SQLite 的错误放在 cause 中
    expect(() => openDatabase(dbPath, main)).toThrow(
      expect.objectContaining({
        cause: expect.objectContaining({
          message: 'duplicate column name: w66_note',
        }) as unknown,
      }) as Error,
    );
  });

  test('只删数据库时，导入本机的 session 与 variant 的 home 中复制的那一份不冲突', async () => {
    const { dataDir, dbPath, dirs, slug } = branchDataDir('db-only');
    for (const f of ['db.sqlite', 'db.sqlite-wal', 'db.sqlite-shm'])
      fs.rmSync(path.join(dataDir, f), { force: true });
    const db = openDatabase(dbPath, main);
    const local = path.join(slug, `${sessionId}.jsonl`);
    await importFiles(db, 'claude', [{ id: sessionId, file: local }]);
    // variant 在数据库中没有记录：它的 home 不是 dashboard 的配置，增量导入不导入复制的那一份
    expect(await tailSessions(db, dirs)).toBe(0);
    expect(db.select({ filePath: sessions.filePath }).from(sessions).all()).toEqual([
      { filePath: local },
    ]);
    db.$client.close();
  });

  test('迁移不一致时删除整个数据目录并给出原因，之后用 main 的迁移新建、导入', async () => {
    const { dataDir, dbPath, slug } = branchDataDir('checked');
    const at = new Date(lastWhen + 1000).toISOString();
    expect(migrationDifferences(dbPath, main)).toEqual([
      `第 ${String(n)} 个迁移在数据库中是 与 ${mainNote} 内容相同的迁移（${at}），仓库中是 ${mainOther}`,
      `数据库中少了 ${mainNote}`,
    ]);
    expect(migrationDifferences(dbPath, config.migrationsDir)).toEqual([
      `数据库中多了 仓库中没有的迁移（${at}）`,
    ]);
    expect(resetOnMigrationChange(dataDir, dbPath, main)).toHaveLength(2);
    expect(fs.existsSync(dataDir)).toBe(false);
    const db = openDatabase(dbPath, main);
    await importFiles(db, 'claude', [
      { id: sessionId, file: path.join(slug, `${sessionId}.jsonl`) },
    ]);
    expect(db.select({ id: sessions.id }).from(sessions).all()).toEqual([{ id: sessionId }]);
    expect(db.$client.prepare('select w66_note from runs').all()).toEqual([]);
    db.$client.close();
    expect(migrationDifferences(dbPath, main)).toEqual([]);
  });
});
