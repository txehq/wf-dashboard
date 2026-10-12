import fs from 'node:fs';
import path from 'node:path';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { type AskQuestion, requests } from '../../src/db/schema.js';
import { answerMenu, pasted } from '../../src/live/keys.js';
import type { LiveDetail, LiveEventView } from '../../src/live/views.js';
import { type LiveServer, sleep, startLiveServer, terminalClient, until } from './harness.js';

// isolated 环境（txehq 中建副本仓库、vault 写 Project Magi Eval/Features/<liveId>/，进程在 sandbox 中）：
// /lfg 做一个计算器 由模拟用户驾驶 interview 的提问；中途从客户端按一个键接管，人回答一次，再交还给模拟用户
let server: LiveServer;

beforeAll(async () => {
  server = await startLiveServer();
}, 600_000);

afterAll(async () => {
  await server.close();
});

const replies = (d: LiveDetail) => d.events.filter((e) => e.kind === 'simulated_reply');
const written = (d: LiveDetail) => replies(d).filter((e) => e.payload.written === true);
const questionsOf = (e: LiveEventView) => (e.payload.questions ?? []) as AskQuestion[];

describe('模拟用户驾驶与接管（真实 claude 与 GitHub）', { timeout: 3_600_000 }, () => {
  test('/lfg 做一个计算器：模拟用户回答 AskUserQuestion，按键接管，交还后接着回答', async () => {
    const startedAt = Date.now();
    const created = await server.api<LiveDetail>('POST', '/api/live', {
      workflow: 'lfg',
      input: '做一个计算器',
      taskId: null,
      variantId: server.variant.id,
      environment: 'isolated',
      cwd: null,
      driver: 'simulated',
    });
    const id = created.id;
    console.log('交互', id, '副本仓库', created.repo);
    expect(created.repo).toBe(`txehq/wfe-${id}`);
    expect(created.events.find((e) => e.kind === 'start')?.payload.sandboxed).toBe(true);
    // 收到 SessionStart 之前驾驶者固定为人；isolated 不弹信任对话框
    expect(created.driver).toBe('human');
    const client = terminalClient(server.url, id);
    await client.opened;
    const driving = await until('模拟用户开始驾驶', 120_000, async () => {
      const d = await server.detail(id);
      return d.starting ? null : d;
    });
    expect(driving.driver).toBe('simulated');
    expect(driving.events.find((e) => e.kind === 'driver')?.payload).toEqual({
      driver: 'simulated',
      reason: 'start',
    });

    // 模拟用户回答 interview 的第一轮
    const first = await until('模拟用户的第一次回答', 900_000, async () => {
      const d = await server.detail(id);
      if (d.error !== null) throw new Error(`交互出错：${d.error}`);
      return written(d).length > 0 ? d : null;
    });
    console.log('第一次回答', JSON.stringify(written(first)[0]?.payload.reply));

    // agent 下一次停下来等输入、模拟用户正在生成回答时，人在终端里按键：驾驶者变为人，生成中的回答作废。
    // 人请 agent 之后用 AskUserQuestion 提问并含一个多选题（这个 variant 的 interview 也可能只用文字提问）
    const next = await until('下一次等待输入', 900_000, async () => {
      const d = await server.detail(id);
      if (d.error !== null) throw new Error(`交互出错：${d.error}`);
      return d.waiting !== null && written(d).length === written(first).length ? d : null;
    });
    const waiting = next.waiting;
    if (waiting === null) throw new Error('没有等待的输入');
    const instruction =
      '接下来的问题请都用 AskUserQuestion 工具问我，其中至少有一个问题是多选题（multiSelect true），比如计算器还需要哪些功能。';
    await sleep(1500);
    // 文字提问时按键就是人要说的话；选项菜单中按 ↓（只移动光标）
    client.input(waiting.kind === 'text' ? pasted(instruction) : '\u001b[B');
    const human = await until('驾驶者变为人', 30_000, async () => {
      const d = await server.detail(id);
      return d.driver === 'human' ? d : null;
    });
    expect(human.events.findLast((e) => e.kind === 'driver')?.payload).toEqual({
      driver: 'human',
      reason: 'input',
    });
    expect(human.handedBack).toBe('input');
    await until('作废的回答', 120_000, async () => {
      const d = await server.detail(id);
      return replies(d).some((e) => e.payload.written === false && 'discarded' in e.payload)
        ? true
        : null;
    });
    if (waiting.kind === 'text') {
      await sleep(400);
      client.input('\r');
    } else {
      // 人在菜单中回答：第一个问题用"其他"写下请求，其余选第 1 项
      const pty = server.live.controller(id)?.pty;
      if (pty === undefined) throw new Error('交互不在运行中');
      await answerMenu(
        pty,
        waiting.questions,
        waiting.questions.map((_, i) =>
          i === 0
            ? { optionNumbers: [], otherAnswer: instruction }
            : { optionNumbers: [1], otherAnswer: '' },
        ),
        new AbortController().signal,
      );
    }
    await until('人的回答提交', 120_000, async () => {
      const d = await server.detail(id);
      const submitted = d.events.some(
        (e) =>
          e.kind === 'hook' &&
          e.payload.hook_event_name === 'UserPromptSubmit' &&
          String(e.payload.prompt).includes('AskUserQuestion'),
      );
      const answered =
        waiting.kind === 'questions' &&
        (d.waiting === null ||
          (d.waiting.kind === 'questions' && d.waiting.toolUseId !== waiting.toolUseId));
      return submitted || answered ? true : null;
    });
    const before = written(await server.detail(id)).length;

    // 交还：模拟用户接着回答，直到单选与多选都至少回答过一次
    const released = await server.api<LiveDetail>('POST', `/api/live/${id}/driver`, {
      driver: 'simulated',
    });
    expect(released.driver).toBe('simulated');
    expect(released.events.findLast((e) => e.kind === 'driver')?.payload).toEqual({
      driver: 'simulated',
      reason: 'release',
    });
    const done = await until('交还后单选与多选都被回答', 1_800_000, async () => {
      const d = await server.detail(id);
      if (d.error !== null) throw new Error(`交互出错：${d.error}`);
      const all = written(d).filter((e) => e.payload.prompt === 'questions');
      const multi = all.some((e) => questionsOf(e).some((q) => q.multiSelect === true));
      const single = all.some((e) => questionsOf(e).some((q) => q.multiSelect !== true));
      return written(d).length > before && all.length >= 2 && multi && single ? d : null;
    });
    const answeredQuestions = written(done).filter((e) => e.payload.prompt === 'questions');
    expect(answeredQuestions.length).toBeGreaterThanOrEqual(2);
    for (const e of answeredQuestions)
      console.log('模拟用户回答', JSON.stringify(e.payload.answers));

    const simulatedCost = replies(done).reduce(
      (sum, e) => sum + (typeof e.payload.costUsd === 'number' ? e.payload.costUsd : 0),
      0,
    );
    const agentCost =
      server.db
        .select({ cost: sql<number>`sum(${requests.costUsd})` })
        .from(requests)
        .where(eq(requests.sessionId, done.claudeSessionId))
        .get()?.cost ?? 0;
    // 耗时与花费写进 .work/w30/，供报告引用
    const summary = {
      liveId: id,
      repo: created.repo,
      seconds: Math.round((Date.now() - startedAt) / 1000),
      agentCostUsd: agentCost,
      simulatedUserCostUsd: simulatedCost,
      answers: answeredQuestions.map((e) => ({
        questions: questionsOf(e).map((q) => ({
          question: q.question,
          multiSelect: q.multiSelect,
        })),
        answers: e.payload.answers,
      })),
      discarded: replies(done)
        .filter((e) => e.payload.written === false)
        .map((e) => e.payload),
      drivers: done.events.filter((e) => e.kind === 'driver').map((e) => e.payload),
    };
    fs.mkdirSync(path.join(config.repoRoot, '.work/w30'), { recursive: true });
    fs.writeFileSync(
      path.join(config.repoRoot, '.work/w30/live-simulated-summary.json'),
      `${JSON.stringify(summary, null, 2)}\n`,
    );
    client.close();
    const stopped = await server.api<LiveDetail>('POST', `/api/live/${id}/stop`);
    expect(stopped.status).toBe('exited');
  });
});
