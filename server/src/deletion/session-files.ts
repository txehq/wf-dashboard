import fs from 'node:fs';
import path from 'node:path';
import { inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { sessions } from '../db/schema.js';
import { forgetImports } from '../ingest/imports.js';

// Files deleted with a Claude Code session (Contracts 24.2, 25.3, observed with Claude Code 2.1.295): the main jsonl and
// the same-named subagent and tool-results directory; when the session is in a config directory
// (<config dir>/projects/<project>/<id>.jsonl), also <config dir>/file-history/<id> and session-env/<id>. Only existing ones are listed
export function claudeSessionFiles(s: { id: string; filePath: string }): string[] {
  const projectDir = path.dirname(s.filePath);
  const files = [s.filePath, path.join(projectDir, s.id)];
  if (path.basename(path.dirname(projectDir)) === 'projects') {
    const configDir = path.dirname(path.dirname(projectDir));
    files.push(
      path.join(configDir, 'file-history', s.id),
      path.join(configDir, 'session-env', s.id),
    );
  }
  return files.filter((f) => fs.existsSync(f));
}

// Permanently delete Claude Code sessions: the dashboard sessions (subagents, requests, stages, bindings go via foreign keys)
// and these files on disk. Their Live items are deleted first by the caller (live.removeItem, no running process allowed).
// Shared by "delete together" when deleting variants and workflows (24.2) and by deletion on the Sessions page (25.3)
export function deleteClaudeSessions(db: Db, rows: { id: string; filePath: string }[]): string[] {
  if (rows.length === 0) return [];
  const files = rows.flatMap(claudeSessionFiles);
  const ids = rows.map((s) => s.id);
  db.delete(sessions).where(inArray(sessions.id, ids)).run();
  forgetImports(db, ids);
  for (const f of files) fs.rmSync(f, { recursive: true, force: true });
  return files;
}
