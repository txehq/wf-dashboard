import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { ingestFile } from '../src/ingest/ingest.js';
import { writeInput } from '../src/insights/export.js';
import { loadWorkflow } from '../src/workflows/index.js';
import { IC, unpackSession, workDir } from './helpers/session-fixtures.js';

// Contracts 15.2：导出的 thinking 块只有类型与估算的 token 数。构造的 session 中思考文字都是 x
const dir = workDir('insights-thinking');
const db = openDatabase(path.join(dir, 'db.sqlite'), config.migrationsDir);
const skillsDir = path.join(dir, 'skills');
fs.mkdirSync(skillsDir, { recursive: true });

afterAll(() => {
  db.$client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const usage = (output: number) => ({ input_tokens: 10, output_tokens: output });
const assistant = (id: string, at: string, output: number, block: Record<string, unknown>) => ({
  type: 'assistant',
  uuid: randomUUID(),
  timestamp: at,
  message: { id, model: 'claude-opus-5-5', content: [block], usage: usage(output) },
});
const user = (at: string, content: unknown) => ({
  type: 'user',
  uuid: randomUUID(),
  timestamp: at,
  message: { role: 'user', content },
});

// 第一次请求：thinking、回复文字与一个 tool 调用；第二次：redacted_thinking、只有 signature 的 thinking 与回复；第三次没有 thinking
const records = [
  user('2026-10-13T00:00:00.000Z', '列出文件'),
  assistant('msg_1', '2026-10-13T00:00:02.000Z', 50, {
    type: 'thinking',
    thinking: 'x',
    signature: 'sig-x',
  }),
  assistant('msg_1', '2026-10-13T00:00:02.100Z', 50, { type: 'text', text: 'Reading.' }),
  assistant('msg_1', '2026-10-13T00:00:02.200Z', 50, {
    type: 'tool_use',
    id: 'toolu_1',
    name: 'Bash',
    input: { command: 'ls' },
  }),
  user('2026-10-13T00:00:03.000Z', [
    { type: 'tool_result', tool_use_id: 'toolu_1', content: 'a.txt' },
  ]),
  assistant('msg_2', '2026-10-13T00:00:05.000Z', 31, { type: 'redacted_thinking', data: 'x' }),
  assistant('msg_2', '2026-10-13T00:00:05.100Z', 31, {
    type: 'thinking',
    thinking: '',
    signature: 'sig-empty',
  }),
  assistant('msg_2', '2026-10-13T00:00:05.200Z', 31, { type: 'text', text: 'Done.' }),
  user('2026-10-13T00:00:06.000Z', '好'),
  assistant('msg_3', '2026-10-13T00:00:07.000Z', 2, { type: 'text', text: 'ok' }),
];
const sessionId = randomUUID();
const projectDir = path.join(dir, 'projects', '-fixture-thinking');
fs.mkdirSync(projectDir, { recursive: true });
const file = path.join(projectDir, `${sessionId}.jsonl`);
fs.writeFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(''));
ingestFile(db, file);
ingestFile(db, unpackSession(dir, IC));

const exportSessions = async (ids: string[], name: string) => {
  const inputDir = path.join(dir, name, 'input');
  await writeInput(db, {
    analysisId: 'a-20261013-think1',
    variant: { id: 'v-thinking', name: 'thinking' },
    skillsDir,
    workflow: loadWorkflow(db, 'ic'),
    sessionIds: ids,
    inputDir,
  });
  return (id: string) =>
    fs.readFileSync(path.join(inputDir, 'sessions', `${id}.jsonl`), 'utf8').trim().split('\n');
};

describe('导出的 thinking 块', () => {
  test('只导出类型与 token 数，其余字段与原来的格式逐字节相同', async () => {
    const lines = (await exportSessions([sessionId], 'constructed'))(sessionId);
    // token 数：输出 token 减去回复文字与 tool 调用（名称与 input 的 JSON）的估算数，由这次请求的 thinking 块均分。
    // msg_1：50 - 'Reading.'(2) - 'Bash'(2) - '{"command":"ls"}'(5) = 41；msg_2：31 - 'Done.'(2) = 29，两块各 15、14
    expect(lines).toEqual([
      '{"seq":0,"agent":null,"parentSeq":0,"stage":null,"timestamp":"2026-10-13T00:00:02.000Z","durationMs":2200,"model":"claude-opus-5-5","tokens":{"input":10,"output":50,"cacheRead":0,"cacheCreation":0},"costUsd":0.00104,"attributionSkill":null,"userMessagesBefore":[{"kind":"user","text":"列出文件"}],"skillLoads":[],"thinking":[{"type":"thinking","tokens":41}],"text":"Reading.","toolCalls":[{"id":"toolu_1","name":"Bash","input":{"command":"ls"},"result":"a.txt","isError":false,"spilledOutput":null,"subagentId":null}]}',
      '{"seq":1,"agent":null,"parentSeq":1,"stage":null,"timestamp":"2026-10-13T00:00:05.000Z","durationMs":2200,"model":"claude-opus-5-5","tokens":{"input":10,"output":31,"cacheRead":0,"cacheCreation":0},"costUsd":0.00066,"attributionSkill":null,"userMessagesBefore":[],"skillLoads":[],"thinking":[{"type":"redacted_thinking","tokens":15},{"type":"thinking","tokens":14}],"text":"Done.","toolCalls":[]}',
      '{"seq":2,"agent":null,"parentSeq":2,"stage":null,"timestamp":"2026-10-13T00:00:07.000Z","durationMs":1000,"model":"claude-opus-5-5","tokens":{"input":10,"output":2,"cacheRead":0,"cacheCreation":0},"costUsd":0.00008,"attributionSkill":null,"userMessagesBefore":[{"kind":"user","text":"好"}],"skillLoads":[],"thinking":null,"text":"ok","toolCalls":[]}',
    ]);
    expect(lines.join('\n')).not.toContain('sig-');
  });

  test('真实 session（含子代理）的每个 thinking 只有 type 与 tokens', async () => {
    const lines = (await exportSessions([IC.sessionId], 'ic'))(IC.sessionId);
    const blocks = lines.flatMap((line) => {
      const row = JSON.parse(line) as { thinking: Record<string, unknown>[] | null };
      return row.thinking ?? [];
    });
    expect(blocks.length).toBeGreaterThan(0);
    for (const block of blocks) {
      expect(Object.keys(block)).toEqual(['type', 'tokens']);
      expect(['thinking', 'redacted_thinking']).toContain(block.type);
      expect(Number.isInteger(block.tokens)).toBe(true);
    }
    expect(lines.join('\n')).not.toContain('"signature"');
  });
});
