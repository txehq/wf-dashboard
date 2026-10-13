import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// fixture「请记住暗号」（test/fixtures/live）的副本：换成新的 session id 与工作目录，可以在后面接几轮对话
// （用户与 agent 交替）。agent 的一句以 fixture 中「记住了」那一行为模板（字段都是真实的），换掉 id、时间与文字；
// 每一行的 parentUuid 指向上一行，Claude Code resume 时按这条链读出对话
const fixture = fs.readFileSync(
  path.join(import.meta.dirname, '../fixtures/live/cfa31f10-e280-4908-bcf7-cbe9b00fbe53.jsonl'),
  'utf8',
);

export function sessionLines(sessionId: string, cwd: string, extra: string[] = []): string {
  const base = fixture
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const entry = JSON.parse(l) as Record<string, unknown>;
      if ('sessionId' in entry) entry.sessionId = sessionId;
      if ('cwd' in entry) entry.cwd = cwd;
      return entry;
    });
  const template = base.find((e) => {
    const message = e.message as { content?: unknown } | undefined;
    return (
      e.type === 'assistant' &&
      Array.isArray(message?.content) &&
      JSON.stringify(message.content).includes('"type":"text"')
    );
  });
  if (template === undefined) throw new Error('fixture 中没有 agent 的文字');
  let parent = base.findLast((e) => typeof e.uuid === 'string')?.uuid;
  if (typeof parent !== 'string') throw new Error('fixture 中没有带 uuid 的行');
  const turns = extra.map((text, i) => {
    const uuid = randomUUID();
    const timestamp = new Date(Date.UTC(2026, 9, 13, 9, i)).toISOString();
    const message = template.message as Record<string, unknown>;
    const entry =
      i % 2 === 0
        ? {
            parentUuid: parent,
            isSidechain: false,
            type: 'user',
            message: { role: 'user', content: text },
            uuid,
            timestamp,
            sessionId,
            cwd,
          }
        : {
            ...template,
            parentUuid: parent,
            uuid,
            timestamp,
            message: { ...message, id: `msg_${randomUUID()}`, content: [{ type: 'text', text }] },
          };
    parent = uuid;
    return entry;
  });
  return `${[...base, ...turns].map((e) => JSON.stringify(e)).join('\n')}\n`;
}
