import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';
import { syncBuiltinWorkflows } from '../workflows/index.js';

export function openDatabase(dbPath: string, migrationsDir: string) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: migrationsDir });
  // 内置的 dev-workflow 以 YAML 为准（Contracts 16.1）：task 与 variant 的校验都读 workflows 表
  syncBuiltinWorkflows(db);
  return db;
}

export type Db = ReturnType<typeof openDatabase>;
