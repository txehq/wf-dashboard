import fs from 'node:fs';
import zlib from 'node:zlib';
import { z } from 'zod';

// session jsonl（可以是 gzip 保存的 fixture）中第一条记录的工作目录，与服务端读出的项目相同（ingest 的 head.cwd）。
// fixture 是真实 session 的原文，工作目录是录下它的那台机器上的路径
export function fixtureCwd(file: string): string {
  const raw = fs.readFileSync(file);
  const text = (file.endsWith('.gz') ? zlib.gunzipSync(raw) : raw).toString('utf8');
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const { cwd } = z.looseObject({ cwd: z.string().optional() }).parse(JSON.parse(line));
    if (cwd !== undefined) return cwd;
  }
  throw new Error(`${file} 中没有 cwd`);
}
