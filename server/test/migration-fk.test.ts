import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, expect, test } from 'vitest';
import { z } from 'zod';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';

// 迁移在关闭外键时运行（src/db/index.ts）：重建被引用的表（0023 让 analyses.variant_id 可空）不经 ON DELETE 删除或改写
// 引用它的行。先只迁移到 0023 之前，写入一次分析、它的发现与修改建议、由它另存的 variant，再迁移到最新
const work = path.join(config.repoRoot, '.work', 'test-migration-fk', randomUUID());

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

const Journal = z.looseObject({ entries: z.array(z.looseObject({ tag: z.string() })) });

test('重建 analyses 时发现、修改建议与另存的 variant 的 analysis_id 都保留', () => {
  const partial = path.join(work, 'drizzle');
  fs.cpSync(config.migrationsDir, partial, { recursive: true });
  const journalFile = path.join(partial, 'meta/_journal.json');
  const journal = Journal.parse(JSON.parse(fs.readFileSync(journalFile, 'utf8')));
  const at = journal.entries.findIndex((e) => e.tag === '0023_sessions-engine');
  expect(at).toBeGreaterThan(0);
  fs.writeFileSync(
    journalFile,
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, at) }, null, 2),
  );
  const file = path.join(work, 'db.sqlite');
  openDatabase(file, partial).$client.close();

  const raw = new Database(file);
  raw.exec(`
    insert into variants (id, name, workflow_id, base_commit, skills_hash, version)
      values ('v1', 'v1', 'ic', '', '', ''), ('v2', '另存的', 'ic', '', '', '');
    insert into analyses (id, engine, model, variant_id, session_ids, steps)
      values ('a-20261014-keep01', 'claude', 'm', 'v1', '[]', '[]');
    update variants set analysis_id = 'a-20261014-keep01' where id = 'v2';
    insert into analysis_findings (analysis_id, finding_id, aspect, title, severity, detail, evidence)
      values ('a-20261014-keep01', 'failures-1', 'failures', 't', 'high', 'd', '[]');
    insert into analysis_patches (analysis_id, file, finding_ids, rationale, patch)
      values ('a-20261014-keep01', 'ic/SKILL.md', '["failures-1"]', 'r', 'p');
  `);
  raw.close();

  const db = openDatabase(file, config.migrationsDir);
  const count = (table: string) =>
    (db.$client.prepare(`select count(*) as n from ${table}`).get() as { n: number }).n;
  expect([count('analyses'), count('analysis_findings'), count('analysis_patches')]).toEqual([
    1, 1, 1,
  ]);
  expect(db.$client.prepare("select analysis_id from variants where id = 'v2'").get()).toEqual({
    analysis_id: 'a-20261014-keep01',
  });
  // 迁移后外键照常生效
  expect(db.$client.pragma('foreign_keys', { simple: true })).toBe(1);
  db.$client.close();
});
