import { cp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { pathExists } from '../dirs/exists.js';

// Before resume, compare a session's two jsonl copies (Contracts 14.5): the latest (sessions.file_path) and the target config's

// The target copy relative to the latest:
// same: same file or byte-identical; behind: target is a prefix of the latest; ahead: latest is a prefix of the target (target kept writing);
// diverged: the two copies diverged
export type CopyRelation = 'same' | 'behind' | 'ahead' | 'diverged';

export async function relationOf(latest: string, target: string): Promise<CopyRelation> {
  if (path.resolve(latest) === path.resolve(target)) return 'same';
  const [a, b] = await Promise.all([readFile(latest), readFile(target)]);
  if (a.equals(b)) return 'same';
  if (b.length < a.length && a.subarray(0, b.length).equals(b)) return 'behind';
  if (a.length < b.length && b.subarray(0, a.length).equals(a)) return 'ahead';
  return 'diverged';
}

// One jsonl line: only the fields needed to find the last message
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

// The main agent's last message with text in a jsonl: time, speaker and summary. A last line without a newline is still being written and is skipped
export async function lastMessage(file: string): Promise<{
  at: string | null;
  role: 'user' | 'assistant' | null;
  text: string | null;
}> {
  const lines = (await readFile(file, 'utf8')).split('\n');
  // Empty when the file ends with a newline; otherwise a half-written line
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

// On divergence the target copy is kept as <id>.jsonl.diverged-<time>
export function divergedName(file: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `${file}.diverged-${stamp}`;
}

// The subagent directory (named like the jsonl) follows the latest: its files overwrite, extra files only in the target are kept
export async function syncSessionDir(fromJsonl: string, toJsonl: string): Promise<void> {
  const id = path.basename(fromJsonl, '.jsonl');
  const from = path.join(path.dirname(fromJsonl), id);
  if (!(await pathExists(from))) return;
  await cp(from, path.join(path.dirname(toJsonl), id), { recursive: true, force: true });
}
