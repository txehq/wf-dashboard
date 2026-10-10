import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

// test/fixtures/runs/<runId>/ 下逐个文件 gzip 保存的真实 run session（主 jsonl、子代理、tool-results），
// 解压到 dest 下保持原目录结构；返回主 jsonl 的路径
export function unpackRunFixture(runId: string, sessionId: string, dest: string): string {
  const fixture = path.join(import.meta.dirname, '../fixtures/runs', runId);
  for (const entry of fs.readdirSync(fixture, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const from = path.join(entry.parentPath, entry.name);
    const to = path.join(dest, path.relative(fixture, from).replace(/\.gz$/, ''));
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, zlib.gunzipSync(fs.readFileSync(from)));
  }
  return path.join(dest, `${sessionId}.jsonl`);
}
