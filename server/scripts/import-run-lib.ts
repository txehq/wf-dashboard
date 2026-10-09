import path from 'node:path';
import Database from 'better-sqlite3';
import type { Db } from '../src/db/index.js';
import { ingestFile } from '../src/ingest/ingest.js';
import { analyzeSession } from '../src/stages/report.js';

// 把另一个数据目录（例如 W4 worktree 的 data/）中一个已结束的 run 导入 db：
// variant、batch、run、对话、产物与评分按行复制；session 从来源 variant 的 jsonl 重新导入，阶段离线重新判定。
// 导入的 variant 没有安装目录，记为未构建，不能用来发起新的 batch。

type Row = Record<string, unknown>;

export interface ImportSource {
  // 来源数据目录（其中有 variants/<id>/home/claude/projects/<run id>/<session>.jsonl）
  dataDir: string;
  // 来源数据库，默认为数据目录下的 db.sqlite
  dbPath?: string;
}

export function isImported(db: Db, runId: string): boolean {
  return db.$client.prepare('select 1 from runs where id = ?').get(runId) !== undefined;
}

export async function importRun(
  db: Db,
  from: ImportSource,
  runId: string,
  stageCheckModel: string,
) {
  const sourceDir = path.resolve(from.dataDir);
  const source = new Database(path.resolve(from.dbPath ?? path.join(sourceDir, 'db.sqlite')), {
    readonly: true,
    fileMustExist: true,
  });
  const target = db.$client;

  const one = (sql: string, ...params: unknown[]): Row => {
    const row = source.prepare(sql).get(...params) as Row | undefined;
    if (row === undefined) throw new Error(`来源中没有：${sql} ${JSON.stringify(params)}`);
    return row;
  };
  const all = (sql: string, ...params: unknown[]): Row[] =>
    source.prepare(sql).all(...params) as Row[];
  // 按列名插入；返回新行的 rowid
  const insert = (table: string, row: Row): number => {
    const columns = Object.keys(row);
    const statement = target.prepare(
      `insert into ${table} (${columns.map((c) => `"${c}"`).join(', ')}) values (${columns.map(() => '?').join(', ')})`,
    );
    return Number(statement.run(...columns.map((c) => row[c])).lastInsertRowid);
  };
  const exists = (table: string, column: string, value: unknown): boolean =>
    target.prepare(`select 1 from ${table} where "${column}" = ?`).get(value) !== undefined;
  // 复制行时去掉自增 id，由目标库重新分配
  const withoutId = (row: Row): Row =>
    Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'id'));

  if (isImported(db, runId)) throw new Error(`run ${runId} 已经导入过`);
  const run = one('select * from runs where id = ?', runId);
  if (run.status !== 'succeeded' && run.status !== 'failed' && run.status !== 'cancelled') {
    throw new Error(`run ${runId} 还没有结束：${String(run.status)}`);
  }
  const variantId = String(run.variant_id);
  const batchId = String(run.batch_id);

  target.transaction(() => {
    if (!exists('variants', 'id', variantId)) {
      const variant = one('select * from variants where id = ?', variantId);
      insert('variants', {
        ...variant,
        name: `${String(variant.name)}（导入 ${variantId.slice(0, 8)}）`,
        install_dir: null,
        build_status: 'none',
        built_hash: null,
        build_error: `从 ${sourceDir} 导入，没有安装目录`,
      });
    }
    if (!exists('batches', 'id', batchId)) {
      insert('batches', one('select * from batches where id = ?', batchId));
      for (const row of all('select * from batch_variants where batch_id = ?', batchId)) {
        if (exists('variants', 'id', row.variant_id)) insert('batch_variants', row);
      }
      for (const row of all('select * from batch_tasks where batch_id = ?', batchId)) {
        insert('batch_tasks', row);
      }
    }
    insert('runs', run);
    for (const row of all('select * from run_messages where run_id = ?', runId)) {
      insert('run_messages', withoutId(row));
    }
    const artifactIds = new Map<unknown, number>();
    for (const row of all('select * from artifacts where run_id = ?', runId)) {
      artifactIds.set(row.id, insert('artifacts', withoutId(row)));
    }
    for (const row of all('select * from grades where run_id = ?', runId)) {
      const gradeId = insert('grades', {
        ...withoutId(row),
        artifact_id: row.artifact_id === null ? null : artifactIds.get(row.artifact_id),
      });
      for (const item of all('select * from grade_items where grade_id = ?', row.id)) {
        insert('grade_items', { ...withoutId(item), grade_id: gradeId });
      }
    }
  })();
  source.close();

  const sessionId = String(run.session_id);
  ingestFile(
    db,
    path.join(
      sourceDir,
      'variants',
      variantId,
      'home/claude/projects',
      runId,
      `${sessionId}.jsonl`,
    ),
  );
  const report = await analyzeSession(db, sessionId, stageCheckModel);
  return {
    runId,
    sessionId,
    stages: [...report.lfg, ...report.ic].flatMap((c) =>
      c.stages.map((s) => `${s.stage}:${s.status}`),
    ),
  };
}
