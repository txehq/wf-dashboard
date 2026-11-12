import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Db } from '../src/db/index.js';
import { ingestFile } from '../src/ingest/ingest.js';
import { readReport } from '../src/stages/report.js';
import { dataLayout } from '../src/variants/layout.js';

// Import a finished run from another data dir (e.g. data/ of the W4 worktree) into db:
// variant, batch, run, messages, artifacts and grades are copied row by row; the session is re-imported from the source variant's jsonl and stages are re-determined offline.
// The imported variant has no install dir, is recorded as unbuilt and cannot start a new batch;
// its skills and baseline export are copied into the target data dir, where the Variants page's file list and diff read them.

type Row = Record<string, unknown>;

export interface ImportSource {
  // Source data dir (contains variants/<id>/home/claude/projects/<run id>/<session>.jsonl)
  dataDir: string;
  // Source database, defaults to db.sqlite in the data dir
  dbPath?: string;
}

// Copy the variant's src/skills/ and variant.json, plus the baseline commit's export (when missing in the target);
// home/, dist/ and binaries are not copied. Parts already in the target stay unchanged; returns the copied paths
export function copyVariantContent(
  sourceDataDir: string,
  targetDataDir: string,
  variantId: string,
  baseCommit: string,
): string[] {
  const from = dataLayout(path.resolve(sourceDataDir));
  const to = dataLayout(path.resolve(targetDataDir));
  const pairs = [
    [from.variant(variantId).skills, to.variant(variantId).skills],
    [from.variant(variantId).manifest, to.variant(variantId).manifest],
    [from.base(baseCommit), to.base(baseCommit)],
  ] as const;
  const copied: string[] = [];
  for (const [source, target] of pairs) {
    if (fs.existsSync(target)) continue;
    if (!fs.existsSync(source)) throw new Error(`Missing in source: ${source}`);
    fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
    copied.push(target);
  }
  return copied;
}

// Fill in the content of every imported variant (rows without an install dir) in the target database, copied from the first source data dir that has the variant's skills.
// Opens the database read only, so it can run while the server is running
export function repairImportedVariants(
  targetDbPath: string,
  targetDataDir: string,
  sourceDataDirs: string[],
): { variantId: string; from: string; copied: string[] }[] {
  const target = new Database(path.resolve(targetDbPath), { readonly: true, fileMustExist: true });
  // A split-off ic variant shares its directory with the lfg variant of the same name (Contracts 16.4): fill in per directory, once each
  const rows = target
    .prepare(
      'select distinct coalesce(storage_id, id) as id, base_commit from variants where install_dir is null',
    )
    .all() as { id: string; base_commit: string }[];
  target.close();
  return rows.map(({ id, base_commit }) => {
    const from = sourceDataDirs.find((dir) =>
      fs.existsSync(dataLayout(path.resolve(dir)).variant(id).skills),
    );
    if (from === undefined) {
      throw new Error(`No source data dir has variant ${id}: ${sourceDataDirs.join(', ')}`);
    }
    return {
      variantId: id,
      from,
      copied: copyVariantContent(from, targetDataDir, id, base_commit),
    };
  });
}

export function isImported(db: Db, runId: string): boolean {
  return db.$client.prepare('select 1 from runs where id = ?').get(runId) !== undefined;
}

export function importRun(
  db: Db,
  from: ImportSource,
  runId: string,
  // Target data dir (the current config.dataDir)
  targetDataDir: string,
) {
  const sourceDir = path.resolve(from.dataDir);
  const source = new Database(path.resolve(from.dbPath ?? path.join(sourceDir, 'db.sqlite')), {
    readonly: true,
    fileMustExist: true,
  });
  const target = db.$client;

  const one = (sql: string, ...params: unknown[]): Row => {
    const row = source.prepare(sql).get(...params) as Row | undefined;
    if (row === undefined) throw new Error(`Missing in source: ${sql} ${JSON.stringify(params)}`);
    return row;
  };
  const all = (sql: string, ...params: unknown[]): Row[] =>
    source.prepare(sql).all(...params) as Row[];
  // Insert by column name; returns the new row's rowid
  const insert = (table: string, row: Row): number => {
    const columns = Object.keys(row);
    const statement = target.prepare(
      `insert into ${table} (${columns.map((c) => `"${c}"`).join(', ')}) values (${columns.map(() => '?').join(', ')})`,
    );
    return Number(statement.run(...columns.map((c) => row[c])).lastInsertRowid);
  };
  const exists = (table: string, column: string, value: unknown): boolean =>
    target.prepare(`select 1 from ${table} where "${column}" = ?`).get(value) !== undefined;
  // Drop the autoincrement id when copying rows; the target database assigns a new one
  const withoutId = (row: Row): Row =>
    Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'id'));

  if (isImported(db, runId)) throw new Error(`Run ${runId} was already imported`);
  const run = one('select * from runs where id = ?', runId);
  if (run.status !== 'succeeded' && run.status !== 'failed' && run.status !== 'cancelled') {
    throw new Error(`Run ${runId} has not finished: ${String(run.status)}`);
  }
  const variantId = String(run.variant_id);
  const batchId = String(run.batch_id);
  const baseCommit = String(
    one('select base_commit from variants where id = ?', variantId).base_commit,
  );
  copyVariantContent(sourceDir, targetDataDir, variantId, baseCommit);
  // When the source predates Contracts 16.5, model and effort live on the variant; the run takes its variant's values at the time (as the migration does)
  const {
    model: variantModel,
    effort: variantEffort,
    ...variant
  } = one('select * from variants where id = ?', variantId);
  const runModel = 'model' in run ? run.model : variantModel;
  const runEffort = 'effort' in run ? run.effort : variantEffort;

  target.transaction(() => {
    if (!exists('variants', 'id', variantId)) {
      // The variant belongs to the built-in workflow named after the run's task kind (Contracts 16.4)
      const kind = target.prepare('select kind from tasks where id = ?').get(run.task_id) as
        { kind: string } | undefined;
      if (kind === undefined) {
        throw new Error(`Target database has no task ${String(run.task_id)} for run ${runId}`);
      }
      insert('variants', {
        ...variant,
        name: `${String(variant.name)} (imported ${variantId.slice(0, 8)})`,
        workflow_id: kind.kind,
        install_dir: null,
        build_status: 'none',
        built_hash: null,
        build_error: `Imported from ${sourceDir}, no install dir`,
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
    insert('runs', { ...run, model: runModel, effort: runEffort });
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
    // When the source database predates the grading status of Contracts 7.6, runs with grades are marked done
    if (all('select id from grades where run_id = ?', runId).length > 0) {
      target.prepare(`update runs set grading_status = 'done' where id = ?`).run(runId);
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
  const report = readReport(db, sessionId);
  if (report === null) throw new Error(`Session ${sessionId} was not imported`);
  return {
    runId,
    sessionId,
    stages: report.workflows
      .flatMap((w) => w.cycles)
      .flatMap((c) => c.stages.map((s) => `${s.stage}:${s.status}`)),
  };
}
