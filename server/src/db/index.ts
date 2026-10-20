import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';
import { syncBuiltinWorkflows } from '../workflows/index.js';
import { splitDevWorkflow } from '../workflows/split-dev-workflow.js';

export function openDatabase(dbPath: string, migrationsDir: string) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  // 迁移在关闭外键时运行（SQLite 改表结构的做法）：drizzle-kit 重建表时写的 PRAGMA foreign_keys=OFF 在迁移的事务中
  // 不起作用，重建被引用的表会经 ON DELETE 删除或改写引用它的行（W62 的 0022 重建 analyses 时 analysis_findings 被清空）。
  // 迁移后检查外键，有违反时以原文报错
  sqlite.pragma('foreign_keys = OFF');
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: migrationsDir });
  const violations = sqlite.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0)
    throw new Error(`迁移后外键不一致（${dbPath}）：${JSON.stringify(violations)}`);
  sqlite.pragma('foreign_keys = ON');
  // 内置的 lfg 与 ic 以 YAML 为准（Contracts 16.1）：variant 与 run 的校验都读 workflows 表
  syncBuiltinWorkflows(db);
  // 迁移 0012 的数据步骤：W36 的 dev-workflow 的 variant 拆成 lfg 与 ic 两个（16.4）
  splitDevWorkflow(db);
  return db;
}

export type Db = ReturnType<typeof openDatabase>;
