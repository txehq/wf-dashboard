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
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: migrationsDir });
  // 内置的 lfg 与 ic 以 YAML 为准（Contracts 16.1）：variant 与 run 的校验都读 workflows 表
  syncBuiltinWorkflows(db);
  // 迁移 0012 的数据步骤：W36 的 dev-workflow 的 variant 拆成 lfg 与 ic 两个（16.4）
  splitDevWorkflow(db);
  return db;
}

export type Db = ReturnType<typeof openDatabase>;
