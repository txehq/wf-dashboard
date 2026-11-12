import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { config } from '../../src/config.js';
import { type Db, openDatabase } from '../../src/db/index.js';
import { requests, sessions } from '../../src/db/schema.js';
import { initialParseState } from '../../src/ingest/ingest.js';
import type { RequestRow } from '../../src/stages/rows.js';

const dir = path.join(config.repoRoot, '.work', 'test-db');

export function openTestDb(): { db: Db; close: () => void } {
  const file = path.join(dir, `${randomUUID()}.sqlite`);
  const db = openDatabase(file, config.migrationsDir);
  return {
    db,
    close: () => {
      db.$client.close();
      for (const suffix of ['', '-wal', '-shm']) rmSync(file + suffix, { force: true });
    },
  };
}

// A session composed from request rows of imported samples (the lfg offline rule tests add real wf obsidian calls)
export function insertSession(db: Db, sessionId: string, rows: RequestRow[], cwd: string | null) {
  const times = rows.map((r) => r.timestamp.getTime());
  db.insert(sessions)
    .values({
      id: sessionId,
      filePath: `/composed/${sessionId}.jsonl`,
      cwd,
      startedAt: new Date(Math.min(...times)),
      endedAt: new Date(Math.max(...times)),
      parseState: initialParseState(),
    })
    .run();
  // SQLite assigns the id
  for (const row of rows) {
    db.insert(requests)
      .values({ ...row, sessionId, id: undefined })
      .run();
  }
}
