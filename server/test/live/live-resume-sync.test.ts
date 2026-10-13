import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { requests } from '../../src/db/schema.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import { pasted } from '../../src/live/keys.js';
import type { LiveDetail, ResumePlan } from '../../src/live/views.js';
import { sessionLines } from '../helpers/session-copies.js';
import { type LiveServer, sleep, startLiveServer, terminalClient, until } from './harness.js';

// 真实档（Contracts 14.5）：本机配置中接着写过、variant 中留着较早的一份时从 variant resume。
// 最新那份（在临时 HOME 的 .claude 中，不碰真实的 ~/.claude）比 variant 中的那份多一轮"第二个暗号：蓝鲸-12"；
// resume 前用最新的覆盖 variant 中的那份，Claude Code 能答出最新那一轮的内容。用 sonnet、low，只问一句
const work = path.join(config.repoRoot, '.work', 'w49', 'real', randomUUID());
const home = path.join(work, 'home');
const cwd = path.join(work, 'cwd');

let server: LiveServer;

beforeAll(async () => {
  fs.mkdirSync(cwd, { recursive: true });
  server = await startLiveServer({ localHome: home });
}, 600_000);

afterAll(async () => {
  await server.close();
});

const sessionCost = (sessionId: string) =>
  server.db
    .select({ cost: sql<number>`coalesce(sum(${requests.costUsd}), 0)` })
    .from(requests)
    .where(eq(requests.sessionId, sessionId))
    .get()?.cost ?? 0;

const hookEvent = async (liveId: string, name: string) =>
  (await server.detail(liveId)).events.find(
    (e) => e.kind === 'hook' && e.payload.hook_event_name === name,
  ) ?? null;

test(
  'variant 中留着较早的一份：先同步最新内容再 resume，Claude Code 答得出最新一轮',
  { timeout: 600_000 },
  async () => {
    const t0 = Date.now();
    const id = randomUUID();
    const latest = path.join(home, '.claude', 'projects', 'l-local', `${id}.jsonl`);
    fs.mkdirSync(path.dirname(latest), { recursive: true });
    const newer = ['第二个暗号是：蓝鲸-12。只回答：记住了', '记住了'];
    fs.writeFileSync(latest, sessionLines(id, cwd, newer));
    ingestFile(server.db, latest);
    // 构造的那几轮按 fixture 的用量记了花费：报告中只计 resume 之后新增的
    const costBefore = sessionCost(id);
    const claudeDir = server.variants.layout(server.variant.id).claudeDir;
    const older = path.join(claudeDir, 'projects', 'l-variant', `${id}.jsonl`);
    fs.mkdirSync(path.dirname(older), { recursive: true });
    fs.writeFileSync(older, sessionLines(id, cwd));

    const plan = await server.api<ResumePlan>(
      'GET',
      `/api/live/resume-plan?sessionId=${id}&variantId=${server.variant.id}`,
    );
    expect(plan).toMatchObject({ action: 'sync', problems: [] });
    const live = await server.api<LiveDetail>('POST', '/api/live/resume', {
      sessionId: id,
      variantId: server.variant.id,
      driver: 'human',
      model: 'sonnet',
      effort: 'low',
    });
    expect(live.events.find((e) => e.kind === 'resume')?.payload).toMatchObject({
      syncedFrom: latest,
      overwrote: older,
    });
    expect(fs.readFileSync(older, 'utf8')).toBe(fs.readFileSync(latest, 'utf8'));

    const client = terminalClient(server.url, live.id);
    await client.opened;
    await until('SessionStart', 120_000, () => hookEvent(live.id, 'SessionStart'));
    await until('输入框', 30_000, async () =>
      (await client.screen()).some((l) => l.startsWith('❯')) ? true : null,
    );
    client.input(pasted('我上一条消息让你记住的暗号是什么？只回答暗号本身。'));
    await sleep(400);
    client.input('\r');
    const stop = await until('Stop', 300_000, () => hookEvent(live.id, 'Stop'));
    expect(String(stop.payload.last_assistant_message)).toContain('蓝鲸-12');
    client.close();
    const stopped = await server.api<LiveDetail>('POST', `/api/live/${live.id}/stop`);
    expect(stopped.status).toBe('exited');
    ingestFile(server.db, older);
    // 报告中写明耗时与花费（真实档的输出不打印 console）
    const record = path.join(config.repoRoot, '.work', 'w49', 'test-costs.jsonl');
    fs.mkdirSync(path.dirname(record), { recursive: true });
    const entry = {
      name: '同步后 resume 并问一句',
      seconds: Math.round((Date.now() - t0) / 1000),
      costUsd: sessionCost(id) - costBefore,
      at: new Date(),
    };
    fs.appendFileSync(record, `${JSON.stringify(entry)}\n`);
  },
);
