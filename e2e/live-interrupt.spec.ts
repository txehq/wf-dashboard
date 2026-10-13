import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { z } from 'zod';
import type { LiveDetail, LiveSummary } from '../server/src/live/views.js';
import { runsServerPort } from '../ports.js';

// 真实档：全屏中 Esc 打断 Claude Code（Contracts 20.1、20.3）。real 环境中 resume 一个一轮的短 session（variant 配置，
// sonnet、low），全屏后发一句"你好"，回答过程中按 Esc，屏幕出现 Claude Code 打断的提示
const api = `http://127.0.0.1:${String(runsServerPort)}/api`;

const Variant = z.object({
  id: z.string(),
  workflowId: z.string(),
  buildStatus: z.string(),
  builtHash: z.string().nullable(),
  skillsHash: z.string(),
});

// 数据目录中按当前内容构建成功的 lfg variant；没有时建一个基线并构建
async function builtVariant(request: APIRequestContext): Promise<string> {
  const all = z.array(Variant).parse(await (await request.get(`${api}/variants`)).json());
  const built = all.find(
    (v) => v.workflowId === 'lfg' && v.buildStatus === 'built' && v.builtHash === v.skillsHash,
  );
  if (built !== undefined) return built.id;
  const created = await request.post(`${api}/variants`, {
    data: { name: `W47 e2e ${randomUUID().slice(0, 8)}` },
  });
  expect(created.ok()).toBe(true);
  const { id } = z.object({ id: z.string() }).parse(await created.json());
  const build = await request.post(`${api}/variants/${id}/build`, { timeout: 900_000 });
  expect(build.ok()).toBe(true);
  return id;
}

// 一轮的短 session（test/fixtures/live 的"请记住暗号"）的副本：新的 session id，工作目录在 .work/ 下；
// 写进 variant 自己的 projects 目录（variant 的来源目录总是勾选），重新导入勾选的来源后出现在 Sessions 中
const dataDir = path.resolve('.work/e2e/runs-data');
const fixture = path.resolve(
  'server/test/fixtures/live/cfa31f10-e280-4908-bcf7-cbe9b00fbe53.jsonl',
);
async function shortSession(request: APIRequestContext, variantId: string): Promise<string> {
  const sessionId = randomUUID();
  const cwd = path.resolve('.work/w47/real-cwd');
  fs.mkdirSync(cwd, { recursive: true });
  const lines = fs
    .readFileSync(fixture, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const entry = z.looseObject({}).parse(JSON.parse(l));
      if ('sessionId' in entry) entry.sessionId = sessionId;
      if ('cwd' in entry) entry.cwd = cwd;
      return JSON.stringify(entry);
    });
  const dir = path.join(dataDir, 'variants', variantId, 'home/claude/projects/-w47-interrupt');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`);
  const Source = z.object({
    path: z.string(),
    variant: z.string().nullable(),
    checked: z.boolean(),
  });
  const sources = z.array(Source).parse(await (await request.get(`${api}/sources`)).json());
  const checked = sources.filter((s) => s.variant === null && s.checked).map((s) => s.path);
  expect((await request.put(`${api}/sources`, { data: { paths: checked } })).ok()).toBe(true);
  return sessionId;
}

const terminalText = async (page: Page) =>
  ((await page.locator('.xterm-rows').textContent()) ?? '').replaceAll(' ', ' ');

test('全屏中 Esc 打断 Claude Code 的回答', async ({ page, request }) => {
  test.setTimeout(1_200_000);
  const variantId = await builtVariant(request);
  const sessionId = await shortSession(request, variantId);
  const Cost = z.object({ costUsd: z.number(), requestCount: z.number() });
  const cost = async () =>
    Cost.parse(await (await request.get(`${api}/sessions/${sessionId}`)).json());
  const before = await cost();
  const t0 = Date.now();
  const resumed = await request.post(`${api}/live/resume`, {
    data: { sessionId, variantId, driver: 'human', model: 'sonnet', effort: 'low' },
  });
  expect(resumed.status()).toBe(201);
  const live = (await resumed.json()) as LiveDetail;
  const detail = async () =>
    (await (await request.get(`${api}/live/${live.id}`)).json()) as LiveDetail;
  const hooks = async (name: string) =>
    (await detail()).events.filter((e) => e.kind === 'hook' && e.payload.hook_event_name === name)
      .length;

  await page.goto(`/live?item=${live.id}&fullscreen=1`);
  await expect(page.getByTestId('live-fullscreen')).toHaveAttribute('data-fullscreen', 'true');
  await expect.poll(() => hooks('SessionStart'), { timeout: 120_000 }).toBe(1);
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  // 输入框出现后再输入（SessionStart 早于输入框）
  await expect
    .poll(
      async () =>
        (
          await page
            .locator('.xterm-rows > div')
            .evaluateAll((rows) => rows.map((r) => r.textContent.trimStart()))
        ).some((l) => l.startsWith('❯')),
      { timeout: 60_000 },
    )
    .toBe(true);
  await page.keyboard.type('你好');
  await page.keyboard.press('Enter');
  await expect.poll(() => hooks('UserPromptSubmit'), { timeout: 60_000 }).toBe(1);
  // resume 的 session 中可能已有打断的记录：数一数按 Esc 前后的打断提示
  const interrupts = async () => (await terminalText(page)).split('Interrupted').length - 1;
  // 等 Claude Code 开始回答（例如"✻ Burrowing…"）。太早按 Esc 时 Claude Code 只撤回这一轮、
  // 把"你好"放回输入框，不显示打断的提示
  const rows = () =>
    page
      .locator('.xterm-rows > div')
      .evaluateAll((els) => els.map((r) => r.textContent.replaceAll(' ', ' ').trim()));
  await expect
    .poll(
      async () => {
        const lines = await rows();
        // 进行中的一行与状态栏中的"esc to interrupt"（只在回答过程中出现）
        return (
          lines.some((l) => /^\S \p{L}+…/u.test(l)) &&
          lines.some((l) => l.includes('esc to interrupt'))
        );
      },
      { timeout: 60_000, intervals: [200] },
    )
    .toBe(true);
  const shown = await interrupts();
  // 回答过程中按 Esc：进入终端，Claude Code 打断这一轮，全屏不变。Claude Code 在屏幕上显示其中一种（实测）：
  // 已有输出时为"Interrupted · What should Claude do instead?"；还没有输出时撤回这一轮，把"你好"放回输入框
  await page.keyboard.press('Escape');
  await expect
    .poll(
      async () => {
        const lines = await rows();
        const input = lines.filter((l) => l.startsWith('❯')).at(-1);
        const busy = lines.some((l) => l.includes('esc to interrupt'));
        return !busy && ((await interrupts()) > shown || (input?.includes('你好') ?? false));
      },
      { timeout: 60_000 },
    )
    .toBe(true);
  await expect(page.getByTestId('live-fullscreen')).toHaveAttribute('data-fullscreen', 'true');
  await page.screenshot({ path: '.work/screenshots/w47-interrupted.png' });
  const seconds = Math.round((Date.now() - t0) / 1000);

  const stopped = await request.post(`${api}/live/${live.id}/stop`);
  expect(stopped.ok()).toBe(true);
  // 花费：这个 session 在 resume 之后新增的请求（session 记录写进 variant 配置目录中的副本后导入）
  await page.waitForTimeout(2000);
  const after = await cost();
  const items = (await (await request.get(`${api}/live`)).json()) as LiveSummary[];
  expect(items.some((l) => l.id === live.id)).toBe(true);
  fs.mkdirSync('.work/w47', { recursive: true });
  fs.appendFileSync(
    '.work/w47/test-costs.jsonl',
    `${JSON.stringify({
      name: '全屏中 Esc 打断',
      seconds,
      sessionId,
      requests: after.requestCount - before.requestCount,
      costUsd: after.costUsd - before.costUsd,
      at: new Date(),
    })}\n`,
  );
});
