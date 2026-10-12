import fs from 'node:fs';
import path from 'node:path';

// 真实 session 的前一段：写出 source 中第一处含 marker 的那一行，以及它之后直到第一条 assistant 记录（含）的全部行，
// 并复制 session 目录（subagents/、tool-results/）。与 Claude Code 写到这里时磁盘上的文件相同，
// 用于只需要大样本前面一部分的测试，导入的行数与时间随之减少。返回写出的主 jsonl
export function writeSessionPrefix(source: string, destDir: string, marker: string): string {
  const lines = fs.readFileSync(source, 'utf8').split('\n');
  const at = lines.findIndex((l) => l.includes(marker));
  if (at < 0) throw new Error(`${source} 中没有 ${marker}`);
  const reply = lines.findIndex(
    (l, i) => i > at && (JSON.parse(l) as { type: string }).type === 'assistant',
  );
  if (reply < 0) throw new Error(`${source} 中 ${marker} 之后没有 assistant 记录`);
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, path.basename(source));
  fs.writeFileSync(dest, `${lines.slice(0, reply + 1).join('\n')}\n`);
  const sessionDir = source.replace(/\.jsonl$/, '');
  if (fs.existsSync(sessionDir)) {
    fs.cpSync(sessionDir, dest.replace(/\.jsonl$/, ''), { recursive: true });
  }
  return dest;
}
