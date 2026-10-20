import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

// resume 前比较 session 的两份 jsonl（Contracts 14.5）：最新那份（sessions.file_path）与目标配置中的那份

// 目标中的那份相对最新那份：
// same：同一个文件或逐字节相同；behind：目标是最新那份的开头（前一段）；ahead：最新那份是目标的开头（目标接着写过）；
// diverged：两份分叉
export type CopyRelation = 'same' | 'behind' | 'ahead' | 'diverged';

export function relationOf(latest: string, target: string): CopyRelation {
  if (path.resolve(latest) === path.resolve(target)) return 'same';
  const a = fs.readFileSync(latest);
  const b = fs.readFileSync(target);
  if (a.equals(b)) return 'same';
  if (b.length < a.length && a.subarray(0, b.length).equals(b)) return 'behind';
  if (a.length < b.length && b.subarray(0, a.length).equals(a)) return 'ahead';
  return 'diverged';
}

// jsonl 的一行：只取判断最后一条消息需要的字段
const Line = z.looseObject({
  type: z.string().optional(),
  isSidechain: z.boolean().optional(),
  timestamp: z.string().optional(),
  message: z
    .looseObject({
      content: z.union([
        z.string(),
        z.array(z.looseObject({ type: z.string(), text: z.string().optional() })),
      ]),
    })
    .optional(),
});

export const SUMMARY_CHARS = 120;

// 一份 jsonl 中主 agent 最后一条有文字的消息：时间、谁说的与内容摘要。没有换行结尾的最后一行是正在写的，不读
export function lastMessage(file: string): {
  at: string | null;
  role: 'user' | 'assistant' | null;
  text: string | null;
} {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  // 以换行结尾时最后一段为空；否则最后一段写了一半
  lines.pop();
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i];
    if (raw === undefined || raw.trim() === '') continue;
    const line = Line.parse(JSON.parse(raw));
    if (line.isSidechain === true || line.message === undefined) continue;
    if (line.type !== 'user' && line.type !== 'assistant') continue;
    const content = line.message.content;
    const text =
      typeof content === 'string'
        ? content
        : content
            .flatMap((part) => (part.type === 'text' && part.text !== undefined ? [part.text] : []))
            .join('\n');
    if (text.trim() === '') continue;
    const flat = text.replace(/\s+/g, ' ').trim();
    return {
      at: line.timestamp ?? null,
      role: line.type,
      text: flat.length > SUMMARY_CHARS ? `${flat.slice(0, SUMMARY_CHARS)}…` : flat,
    };
  }
  return { at: null, role: null, text: null };
}

// 分叉时保留目标中的那份：<id>.jsonl.diverged-<时间>
export function divergedName(file: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `${file}.diverged-${stamp}`;
}

// 子代理目录（与 jsonl 同名的目录）以最新的为准：最新中有的文件覆盖过去，目标中多出、最新中没有的保留
export function syncSessionDir(fromJsonl: string, toJsonl: string) {
  const id = path.basename(fromJsonl, '.jsonl');
  const from = path.join(path.dirname(fromJsonl), id);
  if (!fs.existsSync(from)) return;
  fs.cpSync(from, path.join(path.dirname(toJsonl), id), { recursive: true, force: true });
}
