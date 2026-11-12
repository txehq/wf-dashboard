import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// Unpack the per-file gzipped content of a fixture directory into dest, keeping the layout and dropping .gz
export function gunzipTree(fixture: string, dest: string) {
  for (const entry of fs.readdirSync(fixture, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const from = path.join(entry.parentPath, entry.name);
    const to = path.join(dest, path.relative(fixture, from).replace(/\.gz$/, ''));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, zlib.gunzipSync(fs.readFileSync(from)));
  }
}

// A real run session gzipped file by file under test/fixtures/runs/<runId>/ (main jsonl, subagents, tool-results),
// unpacked into dest with the same layout; returns the main jsonl path
export function unpackRunFixture(runId: string, sessionId: string, dest: string): string {
  gunzipTree(path.join(import.meta.dirname, '../fixtures/runs', runId), dest);
  return path.join(dest, `${sessionId}.jsonl`);
}
