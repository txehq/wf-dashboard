import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { sessionsRoutes } from '../src/api/sessions.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { requests } from '../src/db/schema.js';
import { ingestFile } from '../src/ingest/ingest.js';
import type { ConversationItem } from '../src/ingest/conversation.js';
import { testSourceDirs } from './helpers/source-dirs.js';
import { samplesDir } from './stages/samples.js';

// 真实样本 f0aca373：/interview 的问答、AskUserQuestion（一次被拒绝、其余有回答）、task-notification
const slug = '-Users-linhaoz-Project-txe-txe-workflow';
const f0 = 'f0aca373-863f-4d62-babd-f48055092328';

const workDir = path.join(config.repoRoot, '.work', 'test-conversation', randomUUID());
const projectsDir = path.join(workDir, 'projects');
fs.mkdirSync(path.join(projectsDir, slug), { recursive: true });
fs.cpSync(path.join(samplesDir, slug, `${f0}.jsonl`), path.join(projectsDir, slug, `${f0}.jsonl`));
fs.cpSync(path.join(samplesDir, slug, f0), path.join(projectsDir, slug, f0), { recursive: true });

const db = openDatabase(path.join(workDir, 'db.sqlite'), config.migrationsDir);
ingestFile(db, path.join(projectsDir, slug, `${f0}.jsonl`));
const app = Fastify();
await app.register(sessionsRoutes, {
  prefix: '/api',
  db,
  dirs: testSourceDirs(workDir, { projectsDir, variantsDir: path.join(workDir, 'variants') }),
});

afterAll(async () => {
  await app.close();
  db.$client.close();
  fs.rmSync(workDir, { recursive: true, force: true });
});

const response = await app.inject({ method: 'GET', url: `/api/sessions/${f0}/conversation` });
const items = response.json<{ items: ConversationItem[] }>().items;
const mainSeqs = new Set(
  db
    .select({ seq: requests.seq })
    .from(requests)
    .where(and(eq(requests.sessionId, f0), isNull(requests.agentId)))
    .all()
    .map((r) => r.seq),
);

describe('GET /sessions/:id/conversation', () => {
  test('按时间排序，每条的 seq 指向主 session 的请求', () => {
    expect(response.statusCode).toBe(200);
    const times = items.map((i) => Date.parse(i.timestamp));
    expect(times).toEqual([...times].sort((a, b) => a - b));
    for (const item of items) {
      if (item.seq !== null) expect(mainSeqs.has(item.seq), JSON.stringify(item)).toBe(true);
    }
    expect(items.filter((i) => i.kind === 'user').length).toBeGreaterThan(200);
  });

  test('第一轮：用户消息与 agent 这一轮最后一段回复', () => {
    expect(items[0]).toMatchObject({
      kind: 'user',
      text: '读一下这个项目，分析什么workflow',
      seq: 0,
    });
    const reply = items[1];
    expect(reply?.kind).toBe('agent');
    expect(reply?.kind === 'agent' && reply.text.startsWith('读完了')).toBe(true);
    // 一轮只有一条 agent：两条用户消息之间不会出现两条 agent
    for (let i = 1; i < items.length; i++) {
      expect(items[i - 1]?.kind === 'agent' && items[i]?.kind === 'agent').toBe(false);
    }
  });

  test('/interview 显示为 slash 命令，之后是 agent 的提问', () => {
    const index = items.findIndex((i) => i.kind === 'user' && i.text === '/interview');
    expect(index).toBeGreaterThan(0);
    const start = items[index];
    const next = items.slice(index + 1).find((i) => i.kind === 'agent');
    expect(start?.seq).not.toBeNull();
    expect(next?.seq).toBeGreaterThanOrEqual(start?.seq ?? Infinity);
    expect(next?.kind === 'agent' && next.text.length > 0).toBe(true);
  });

  test('AskUserQuestion：问题、选项与配对 tool_result 中的回答；被拒绝的没有回答', () => {
    const questions = items.filter((i) => i.kind === 'question');
    expect(questions).toHaveLength(7);
    const rejected = questions[0];
    expect(rejected?.answers).toBeNull();
    expect(rejected?.questions[0]?.question).toContain('这次想 brainstorm 什么');
    const answered = questions.find((q) => q.toolCallId === 'toolu_bdrk_019mb6XDFnPyYupfsdVRfbYZ');
    expect(answered?.questions.map((q) => q.header)).toEqual(['Agent 范围', '问题反馈']);
    expect(answered?.questions[0]?.options.map((o) => o.label)).toContain('三个都装');
    const first = answered?.questions[0]?.question ?? '';
    expect(answered?.answers?.[first]).toBe('三个都装');
    expect(Object.keys(answered?.answers ?? {})).toHaveLength(2);
    expect(questions.filter((q) => q.answers !== null)).toHaveLength(6);
  });

  test('task-notification 与本地命令输出是 notice', () => {
    const notices = items.flatMap((i) => (i.kind === 'notice' ? [i] : []));
    const task = notices.find((n) => n.text.startsWith('<task-notification>'));
    expect(task?.seq).not.toBeNull();
    expect(notices.some((n) => n.text.startsWith('<local-command-stdout>'))).toBe(true);
    expect(items.some((i) => i.kind === 'user' && i.text.startsWith('<task-notification>'))).toBe(
      false,
    );
  });

  test('不存在的 session 返回 404', async () => {
    const missing = await app.inject({ method: 'GET', url: '/api/sessions/nope/conversation' });
    expect(missing.statusCode).toBe(404);
  });
});
