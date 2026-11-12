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
  // Migrations run with foreign keys off (SQLite's way to alter tables): the PRAGMA foreign_keys=OFF drizzle-kit writes when rebuilding a table
  // has no effect inside the migration transaction, so rebuilding a referenced table deletes or rewrites referencing rows via ON DELETE (W62's 0022 emptied analysis_findings when rebuilding analyses).
  // Check foreign keys after migrating and fail with the raw violations
  sqlite.pragma('foreign_keys = OFF');
  const db = drizzle({ client: sqlite, schema });
  migrate(db, { migrationsFolder: migrationsDir });
  const violations = sqlite.pragma('foreign_key_check') as unknown[];
  if (violations.length > 0)
    throw new Error(
      `Foreign keys inconsistent after migration (${dbPath}): ${JSON.stringify(violations)}`,
    );
  sqlite.pragma('foreign_keys = ON');
  // The built-in lfg and ic follow their YAML (Contracts 16.1): variant and run validation both read the workflows table
  syncBuiltinWorkflows(db);
  // Data step of migration 0012: W36's dev-workflow variants are split into lfg and ic (16.4)
  splitDevWorkflow(db);
  return db;
}

export type Db = ReturnType<typeof openDatabase>;
