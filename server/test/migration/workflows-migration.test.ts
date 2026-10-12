import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { config } from '../../src/config.js';
import { openDatabase } from '../../src/db/index.js';

// Contracts 16 的迁移（0011_workflows）：在按旧结构（0000–0010）写入的数据库上执行，现有 variant 归入 dev-workflow，
// run 与交互进程的 model 与 effort 取它所用 variant 的值，task 的 kind 变为 workflow 与大阶段，引用与 session 的绑定不丢，
// 阶段结果清空后按新形状重算
const work = path.join(config.repoRoot, '.work', 'test-migration', randomUUID());
const oldMigrations = path.join(work, 'drizzle');
const dbFile = path.join(work, 'db.sqlite');

const Journal = z.looseObject({ entries: z.array(z.looseObject({ tag: z.string() })) });

// 只含 0000–0010 的迁移目录
function writeOldMigrations() {
  fs.mkdirSync(path.join(oldMigrations, 'meta'), { recursive: true });
  const journal = Journal.parse(
    JSON.parse(fs.readFileSync(path.join(config.migrationsDir, 'meta/_journal.json'), 'utf8')),
  );
  const index = journal.entries.findIndex((e) => e.tag === '0011_workflows');
  expect(index).toBe(11);
  const entries = journal.entries.slice(0, index);
  for (const e of entries) {
    fs.copyFileSync(
      path.join(config.migrationsDir, `${e.tag}.sql`),
      path.join(oldMigrations, `${e.tag}.sql`),
    );
  }
  fs.writeFileSync(
    path.join(oldMigrations, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries }),
  );
}

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

describe('0011_workflows 迁移', () => {
  test('旧结构的 variant、task、run、交互进程、session 与阶段结果迁移到新结构', () => {
    writeOldMigrations();
    const sqlite = new Database(dbFile);
    sqlite.pragma('foreign_keys = ON');
    migrate(drizzle({ client: sqlite }), { migrationsFolder: oldMigrations });
    const now = Date.now();
    const run = (sql: string, ...params: unknown[]) => sqlite.prepare(sql).run(...params);
    run(
      `insert into variants (id, name, base_commit, skills_hash, version, model, effort, status, install_dir, created_at)
       values ('v-base', '基线', 'c1', 'h1', '2.3.0-eval.h1', 'opus', 'high', 'frozen', '/x', ?),
              ('v-mod', '改过的', 'c1', 'h2', '2.3.0-eval.h2', 'sonnet', 'max', 'frozen', '/y', ?)`,
      now,
      now + 1,
    );
    run(`update variants set parent_id = 'v-base' where id = 'v-mod'`);
    run(
      `insert into tasks (id, kind, title, persona, hidden_requirements, input, dir, content_hash, updated_at)
       values ('lfg-calculator', 'lfg', 't', 'p', 'h', '做一个计算器', '/t', 'old', ?),
              ('ic-money-format', 'ic', 't', 'p', 'h', null, '/t', 'old', ?)`,
      now,
      now,
    );
    run(`insert into batches (id, repeats) values ('b-1', 1)`);
    run(
      `insert into runs (id, batch_id, task_id, variant_id, repeat_index, status, session_id, workspace_path)
       values ('r-1', 'b-1', 'lfg-calculator', 'v-base', 0, 'succeeded', 's-1', '/w1'),
              ('r-2', 'b-1', 'ic-money-format', 'v-mod', 0, 'succeeded', 's-2', '/w2')`,
    );
    run(
      `insert into sessions (id, run_id, file_path, started_at, ended_at, parse_state, variant_id, variant_binding)
       values ('s-1', 'r-1', '/f1', ?, ?, '{}', 'v-base', 'run'),
              ('s-3', null, '/f3', ?, ?, '{}', 'v-mod', 'auto')`,
      now,
      now,
      now,
      now,
    );
    // 交互区的一项：先用 v-mod 启动，再以本机配置 resume
    run(
      `insert into live_sessions (id, claude_session_id, title, environment, cwd, updated_at)
       values ('l-1', 's-4', 't', 'real', '/w4', ?)`,
      now,
    );
    run(
      `insert into live_processes (id, live_id, kind, variant_id, status, driver, started_at)
       values (1, 'l-1', 'start', 'v-mod', 'exited', 'human', ?),
              (2, 'l-1', 'resume', null, 'exited', 'human', ?)`,
      now,
      now + 1,
    );
    run(
      `insert into stage_states (session_id, state, folded_seq, updated_at) values ('s-1', '{"cycles":[]}', 3, ?)`,
      now,
    );
    run(
      `insert into stage_cycles (session_id, workflow, cycle, label, start_seq, end_seq) values ('s-1', 'lfg', 1, '/lfg', 0, 3)`,
    );
    run(
      `insert into stage_spans (session_id, workflow, cycle, stage, status, start_seq, end_seq, entries)
       values ('s-1', 'lfg', 1, 'interview', 'done', 0, 3, 1)`,
    );
    sqlite.close();

    const db = openDatabase(dbFile, config.migrationsDir);
    const all = (sql: string) => db.$client.prepare(sql).all();
    expect(all('select id, name, workflow_id from variants order by id')).toEqual([
      { id: 'v-base', name: '基线', workflow_id: 'dev-workflow' },
      { id: 'v-mod', name: '改过的', workflow_id: 'dev-workflow' },
    ]);
    expect(all('select id, variant_id, task_id, model, effort from runs order by id')).toEqual([
      { id: 'r-1', variant_id: 'v-base', task_id: 'lfg-calculator', model: 'opus', effort: 'high' },
      {
        id: 'r-2',
        variant_id: 'v-mod',
        task_id: 'ic-money-format',
        model: 'sonnet',
        effort: 'max',
      },
    ]);
    expect(all('select id, workflow_id, big_stage from tasks order by id')).toEqual([
      { id: 'ic-money-format', workflow_id: 'dev-workflow', big_stage: 'ic' },
      { id: 'lfg-calculator', workflow_id: 'dev-workflow', big_stage: 'lfg' },
    ]);
    // 本机配置的进程没有传 --model 与 --effort，保持为空
    expect(all('select id, variant_id, model, effort from live_processes order by id')).toEqual([
      { id: 1, variant_id: 'v-mod', model: 'sonnet', effort: 'max' },
      { id: 2, variant_id: null, model: null, effort: null },
    ]);
    // session 的绑定与 run 引用不因迁移被置空
    expect(all('select id, run_id, variant_id, variant_binding from sessions order by id')).toEqual(
      [
        { id: 's-1', run_id: 'r-1', variant_id: 'v-base', variant_binding: 'run' },
        { id: 's-3', run_id: null, variant_id: 'v-mod', variant_binding: 'auto' },
      ],
    );
    // 阶段结果清空，读取时按新形状从头划分
    expect(all('select count(*) n from stage_states')).toEqual([{ n: 0 }]);
    expect(all('select count(*) n from stage_spans')).toEqual([{ n: 0 }]);
    expect(
      all("select * from pragma_table_info('stage_spans') where name in ('workflow', 'big_stage')"),
    ).toEqual([expect.objectContaining({ name: 'big_stage' })]);
    // variant 表不再有 model 与 effort；dev-workflow 以最早导入的基线为底子
    expect(
      all("select name from pragma_table_info('variants') where name in ('model', 'effort')"),
    ).toEqual([]);
    expect(all('select id, base_variant_id from workflows')).toEqual([
      { id: 'dev-workflow', base_variant_id: 'v-base' },
    ]);
    expect(all('pragma foreign_key_check')).toEqual([]);
    db.$client.close();
  });
});
