import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { requests } from '../../src/db/schema.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import { pasted } from '../../src/live/keys.js';
import type { LiveDetail, LiveEventView } from '../../src/live/views.js';
import { type LiveServer, sleep, startLiveServer, terminalClient, until } from './harness.js';

// 模拟用户驾驶与接管，用能证明这些行为的最短对话：resume 一个只有一轮的 session（"请记住暗号：青蛙-47"），
// 人请 agent 问一个单选问题再问一句话；交还后模拟用户经按键回答 AskUserQuestion，
// 回答文字提问时按一个键接管（生成中的回答作废），再交还，模拟用户接着回答
const fixtureSession = 'cfa31f10-e280-4908-bcf7-cbe9b00fbe53';
const fixture = path.join(import.meta.dirname, '../fixtures/live', `${fixtureSession}.jsonl`);

let server: LiveServer;

beforeAll(async () => {
  server = await startLiveServer();
}, 600_000);

afterAll(async () => {
  await server.close();
});

const replies = (d: LiveDetail) => d.events.filter((e) => e.kind === 'simulated_reply');
const written = (d: LiveDetail) => replies(d).filter((e) => e.payload.written === true);
const lastDriver = (d: LiveDetail): LiveEventView['payload'] | undefined =>
  d.events.findLast((e) => e.kind === 'driver')?.payload;
// 这个 session 全部请求的花费
const sessionCost = () =>
  server.db
    .select({ cost: sql<number>`coalesce(sum(${requests.costUsd}), 0)` })
    .from(requests)
    .where(eq(requests.sessionId, fixtureSession))
    .get()?.cost ?? 0;

describe('模拟用户驾驶与接管（真实 claude 与 gateway）', { timeout: 1_800_000 }, () => {
  test('模拟用户按键回答 AskUserQuestion；回答文字提问时按键接管，交还后接着回答', async () => {
    const startedAt = Date.now();
    const projects = path.join(config.dataDir, 'home-projects', 'w34-simulated');
    const original = path.join(projects, `${fixtureSession}.jsonl`);
    fs.mkdirSync(projects, { recursive: true });
    fs.copyFileSync(fixture, original);
    ingestFile(server.db, original);
    const costBefore = sessionCost();
    const live = await server.api<LiveDetail>('POST', '/api/live/resume', {
      sessionId: fixtureSession,
      variantId: server.variant.id,
      driver: 'human',
    });
    const id = live.id;
    const client = terminalClient(server.url, id);
    await client.opened;
    await until('SessionStart', 120_000, async () => {
      const d = await server.detail(id);
      if (d.status === 'exited') throw new Error(`进程已退出：${JSON.stringify(d.events.at(-1))}`);
      if ((await client.screen()).join('\n').includes('Yes, I trust this folder')) {
        client.input('\u001b[B');
        await sleep(400);
        client.input('\r');
      }
      return d.starting ? null : d;
    });
    await until('输入框', 30_000, async () =>
      (await client.screen()).some((l) => l.startsWith('❯')) ? true : null,
    );
    client.input(
      pasted(
        '调用一次 AskUserQuestion，只问一个单选问题「选一个颜色」，header「颜色」，选项 红、绿、蓝。得到回答后只回复一句：「好的。还要别的吗？」',
      ),
    );
    await sleep(400);
    client.input('\r');
    await until('人的输入提交', 60_000, async () =>
      (await server.detail(id)).events.some(
        (e) =>
          e.kind === 'hook' &&
          e.payload.hook_event_name === 'UserPromptSubmit' &&
          String(e.payload.prompt).includes('AskUserQuestion'),
      )
        ? true
        : null,
    );

    // 交还：agent 正在生成，没有等待的输入；收到 PreToolUse 后模拟用户经按键回答
    const released = await server.api<LiveDetail>('POST', `/api/live/${id}/driver`, {
      driver: 'simulated',
    });
    expect(released.driver).toBe('simulated');
    expect(lastDriver(released)).toEqual({ driver: 'simulated', reason: 'release' });
    const answered = await until('模拟用户回答 AskUserQuestion', 300_000, async () => {
      const d = await server.detail(id);
      if (d.error !== null) throw new Error(`交互出错：${d.error}`);
      return written(d).find((e) => e.payload.prompt === 'questions') ?? null;
    });
    const answer = (answered.payload.answers as Record<string, string>)['选一个颜色'];
    expect(['红', '绿', '蓝']).toContain(answer);

    // agent 回复"还要别的吗？"（Stop）：模拟用户开始生成文字回答时按一个键，驾驶者变为人，生成中的回答作废
    await until('文字提问', 300_000, async () => {
      const d = await server.detail(id);
      return d.waiting?.kind === 'text' && d.waiting.text.includes('还要') ? true : null;
    });
    client.input('\u001b[B');
    const human = await until('驾驶者变为人', 30_000, async () => {
      const d = await server.detail(id);
      return d.driver === 'human' ? d : null;
    });
    expect(lastDriver(human)).toEqual({ driver: 'human', reason: 'input' });
    expect(human.handedBack).toBe('input');
    await until('作废的回答', 120_000, async () =>
      replies(await server.detail(id)).some(
        (e) => e.payload.written === false && e.payload.discarded === '驾驶者变为人',
      )
        ? true
        : null,
    );
    const before = written(await server.detail(id)).length;

    // 再交还：Claude Code 正在等这句文字提问，模拟用户立即回答（写进 PTY，或认为已结束交给人）
    const again = await server.api<LiveDetail>('POST', `/api/live/${id}/driver`, {
      driver: 'simulated',
    });
    expect(lastDriver(again)).toEqual({ driver: 'simulated', reason: 'release' });
    const reply = await until('交还后的回答', 300_000, async () => {
      const d = await server.detail(id);
      if (d.error !== null) throw new Error(`交互出错：${d.error}`);
      const text = replies(d).filter((e) => e.payload.prompt === 'text');
      const last = text.at(-1);
      return written(d).length > before || last?.payload.done === true ? (last ?? null) : null;
    });
    expect(typeof reply.payload.reply).toBe('string');
    if (reply.payload.done === true) {
      expect(lastDriver(await server.detail(id))).toEqual({ driver: 'human', reason: 'done' });
    }
    client.close();
    const stopped = await server.api<LiveDetail>('POST', `/api/live/${id}/stop`);
    expect(stopped.status).toBe('exited');

    const simulatedCost = replies(stopped).reduce(
      (sum, e) => sum + (typeof e.payload.costUsd === 'number' ? e.payload.costUsd : 0),
      0,
    );
    const agentCost = sessionCost() - costBefore;
    const file = path.join(config.repoRoot, '.work/w34/test-costs.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      `${JSON.stringify({
        name: '模拟用户驾驶与接管',
        seconds: Math.round((Date.now() - startedAt) / 1000),
        // fixture 原有的一轮在测试之前就已产生，不计入
        costUsd: agentCost,
        simulatedUserCostUsd: simulatedCost,
        replies: replies(stopped).map((e) => e.payload),
        at: new Date(),
      })}\n`,
    );
  });
});
