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

// 迁移 0011_workflows 与 0012_workflow-instances（Contracts 16.4）：在按 0000–0010 的结构写入的数据库上执行。
// W36 的 dev-workflow 拆成 lfg 与 ic：每个 variant 拆成两个同名 variant（原 id 属于 lfg，新建的属于 ic 并共用目录）；
// run 按 task 的 kind 对应，交互进程与 session 的绑定按 session 中先出现的标记对应；task 回到 kind；阶段结果清空
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
  const tags = journal.entries.map((e) => e.tag);
  expect(tags.slice(10, 13)).toEqual([
    '0010_live_hidden',
    '0011_workflows',
    '0012_workflow-instances',
  ]);
  const entries = journal.entries.slice(0, 11);
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

describe('0011 与 0012 迁移：dev-workflow 拆成 lfg 与 ic', () => {
  test('variant 拆成两个，run、session 与交互进程按规则对应，task 回到 kind，外键完整', () => {
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
      `insert into batch_variants (batch_id, variant_id) values ('b-1', 'v-base'), ('b-1', 'v-mod')`,
    );
    run(
      `insert into runs (id, batch_id, task_id, variant_id, repeat_index, status, session_id, workspace_path)
       values ('r-1', 'b-1', 'lfg-calculator', 'v-base', 0, 'succeeded', 's-1', '/w1'),
              ('r-2', 'b-1', 'ic-money-format', 'v-mod', 0, 'succeeded', 's-2', '/w2')`,
    );
    const session = `insert into sessions (id, run_id, file_path, started_at, ended_at, parse_state, variant_id, variant_binding)
       values (?, ?, ?, ?, ?, '{}', ?, ?)`;
    run(session, 's-1', 'r-1', '/f1', now, now, 'v-base', 'run');
    run(session, 's-2', 'r-2', '/f2', now, now, 'v-mod', 'run');
    // 没有标记：对应到 lfg 的那个
    run(session, 's-3', null, '/f3', now, now, 'v-mod', 'auto');
    // 先出现的标记是 ic 的小阶段 claim（之后的 interview 不影响）
    run(session, 's-5', null, '/f5', now, now, 'v-base', 'manual');
    const request = `insert into requests (session_id, message_id, seq, timestamp, model, tool_calls,
       input_tokens, output_tokens, cache_creation_tokens, cache_read_tokens, cost_usd)
       values (?, ?, ?, ?, 'claude-opus', ?, 0, 0, 0, 0, 0)`;
    const skillCall = (name: string) =>
      JSON.stringify([
        {
          id: `toolu_${name}`,
          name: 'Skill',
          input: { skill: name },
          result: 'ok',
          resultChars: 2,
          isError: false,
          spillPath: null,
          subagentId: null,
        },
      ]);
    run(request, 's-5', 'm-1', 0, now, skillCall('claim'));
    run(request, 's-5', 'm-2', 1, now + 1, skillCall('interview'));
    // 交互区的一项：session s-4 先出现 /ic 命令；用 v-mod 启动，再以本机配置 resume
    run(session, 's-4', null, '/f4', now, now, 'v-mod', 'run');
    run(request, 's-4', 'm-3', 0, now + 10, '[]');
    run(
      `insert into user_messages (session_id, uuid, timestamp, kind, text) values ('s-4', 'u-1', ?, 'user', ?)`,
      now + 5,
      '<command-name>/ic</command-name> TXE-1',
    );
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
      `insert into stage_cycles (session_id, workflow, cycle, label, start_seq, end_seq) values ('s-1', 'lfg', 1, '/lfg', 0, 3)`,
    );
    sqlite.close();

    const db = openDatabase(dbFile, config.migrationsDir);
    const all = (sql: string) => db.$client.prepare(sql).all();
    const one = (sql: string) => db.$client.prepare(sql).get() as Record<string, unknown>;
    const icOf = (id: string) =>
      String(one(`select id from variants where workflow_id = 'ic' and storage_id = '${id}'`).id);
    const icBase = icOf('v-base');
    const icMod = icOf('v-mod');
    expect(
      all(
        'select id, name, workflow_id, storage_id, parent_id from variants order by workflow_id, name',
      ),
    ).toEqual([
      { id: icBase, name: '基线', workflow_id: 'ic', storage_id: 'v-base', parent_id: null },
      { id: icMod, name: '改过的', workflow_id: 'ic', storage_id: 'v-mod', parent_id: icBase },
      { id: 'v-base', name: '基线', workflow_id: 'lfg', storage_id: null, parent_id: null },
      { id: 'v-mod', name: '改过的', workflow_id: 'lfg', storage_id: null, parent_id: 'v-base' },
    ]);
    // run 按 task 的 kind；model 与 effort 取原 variant 的值（0011）
    expect(all('select id, variant_id, model, effort from runs order by id')).toEqual([
      { id: 'r-1', variant_id: 'v-base', model: 'opus', effort: 'high' },
      { id: 'r-2', variant_id: icMod, model: 'sonnet', effort: 'max' },
    ]);
    expect(
      all(`select variant_id from batch_variants where batch_id = 'b-1' order by variant_id`),
    ).toEqual([icMod, 'v-base'].sort().map((variant_id) => ({ variant_id })));
    // session：run 的 session 跟随 run，其余按先出现的标记，绑定方式不变
    expect(all('select id, variant_id, variant_binding from sessions order by id')).toEqual([
      { id: 's-1', variant_id: 'v-base', variant_binding: 'run' },
      { id: 's-2', variant_id: icMod, variant_binding: 'run' },
      { id: 's-3', variant_id: 'v-mod', variant_binding: 'auto' },
      { id: 's-4', variant_id: icMod, variant_binding: 'run' },
      { id: 's-5', variant_id: icBase, variant_binding: 'manual' },
    ]);
    // 交互进程按这一项的 session 的标记；本机配置的进程保持为空
    expect(all('select id, variant_id, model, effort from live_processes order by id')).toEqual([
      { id: 1, variant_id: icMod, model: 'sonnet', effort: 'max' },
      { id: 2, variant_id: null, model: null, effort: null },
    ]);
    expect(all('select id, kind from tasks order by id')).toEqual([
      { id: 'ic-money-format', kind: 'ic' },
      { id: 'lfg-calculator', kind: 'lfg' },
    ]);
    // workflows：dev-workflow 删除，内置的 lfg 与 ic 带评测类型
    expect(all('select id, eval_kind, copied_from from workflows order by id')).toEqual([
      { id: 'ic', eval_kind: 'ic', copied_from: null },
      { id: 'lfg', eval_kind: 'lfg', copied_from: null },
    ]);
    expect(all('select count(*) n from stage_cycles')).toEqual([{ n: 0 }]);
    expect(
      all(
        "select name from pragma_table_info('stage_spans') where name in ('workflow', 'big_stage')",
      ),
    ).toEqual([{ name: 'workflow' }]);
    expect(all('pragma foreign_key_check')).toEqual([]);
    db.$client.close();

    // 再次打开不重复拆分
    const again = openDatabase(dbFile, config.migrationsDir);
    expect(again.$client.prepare('select count(*) n from variants').get()).toEqual({ n: 4 });
    again.$client.close();
  });
});
