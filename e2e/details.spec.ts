import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { runsServerPort } from '../ports.js';

// 数据目录与 runs.spec.ts 相同：W4 端到端导入的真实 run，它们的 session 在导入时已划分阶段；
// 另外勾选本机 txe-workflow 的来源目录，用其中 f0aca373 的对话区（含 AskUserQuestion）
const api = `http://127.0.0.1:${String(runsServerPort)}/api`;
const source = '/Users/linhaoz/.claude/projects/-Users-linhaoz-Project-txe-txe-workflow';
const f0 = 'f0aca373-863f-4d62-babd-f48055092328';
const lfgRun = 'r-20261009-dqva52';
const icRuns = ['r-20261009-a26chw', 'r-20261009-27yz3d'];
const shots = '.work/screenshots';

test.describe.configure({ mode: 'serial' });
test.setTimeout(10 * 60_000);

interface StageView {
  stage: string;
  status: string;
  startSeq: number | null;
  endSeq: number | null;
}

let lfgSession = '';
let icSession = '';

const sessionOf = async (request: APIRequestContext, run: string) =>
  ((await (await request.get(`${api}/runs/${run}`)).json()) as { sessionId: string }).sessionId;

test.beforeAll(async ({ request }) => {
  const sources = (await (await request.get(`${api}/sources`)).json()) as {
    path: string;
    variant: string | null;
    checked: boolean;
  }[];
  if (sources.find((s) => s.path === source)?.checked !== true) {
    const paths = sources.filter((s) => s.checked && s.variant === null).map((s) => s.path);
    const put = await request.put(`${api}/sources`, { data: { paths: [...paths, source] } });
    expect(put.ok()).toBe(true);
  }
  lfgSession = await sessionOf(request, lfgRun);
  icSession = await sessionOf(request, icRuns[0] ?? '');
});

const noPageScroll = (page: Page) =>
  page.evaluate('document.documentElement.scrollWidth <= document.documentElement.clientWidth');

// 加载、点开一个已完成的阶段、展开前几个 tool 调用，每一步都检查页面级横向滚动
async function checkWidth(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByTestId('timeline').first()).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => noPageScroll(page), { message: `${url} 加载后` }).toBe(true);
  const stage = page.locator('[data-testid^="stage-"][data-status="done"]').first();
  await stage.click();
  await expect(page.getByTestId('stage-requests')).toBeVisible();
  await expect.poll(() => noPageScroll(page), { message: `${url} 点开阶段后` }).toBe(true);
  const tools = page.getByTestId('tool-call').locator('> button');
  const n = Math.min(await tools.count(), 8);
  // 从下往上展开：展开的内容只把下面的行推出虚拟滚动的渲染范围，不影响上面还没展开的行
  for (let i = n - 1; i >= 0; i--) await tools.nth(i).click();
  await expect.poll(() => noPageScroll(page), { message: `${url} 展开 tool 调用后` }).toBe(true);
}

for (const width of [1280, 1440, 1920]) {
  test(`${String(width)}px：两个详情页没有页面级横向滚动`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    for (const url of [`/sessions/${icSession}`, `/sessions/${lfgSession}`]) {
      await checkWidth(page, url);
    }
    for (const run of [lfgRun, ...icRuns]) await checkWidth(page, `/runs/${run}`);
    if (width === 1280) {
      await page.goto(`/sessions/${icSession}`);
      await expect(page.getByTestId('workflow-ic')).toBeVisible();
      await page.screenshot({ path: `${shots}/w20-session-1280.png`, animations: 'disabled' });
      await page.goto(`/runs/${icRuns[1] ?? ''}`);
      await expect(page.getByTestId('timeline')).toBeVisible();
      await page.screenshot({ path: `${shots}/w20-run-1280.png`, animations: 'disabled' });
    }
  });
}

// 请求明细中已渲染的主 session 行的 seq（虚拟滚动：timeline > 高度容器 > 行容器 > 行；子代理的嵌套行不算）
async function visibleSeqs(page: Page): Promise<number[]> {
  const texts = await page
    .locator('[data-testid="timeline"] > div > div > [data-testid="request-row"]')
    .locator('header > span:first-child')
    .allTextContents();
  return texts.map((t) => Number(t.replace('#', '')));
}

test('Runs 详情：点击阶段后请求明细只含该阶段，再点恢复，"显示全部"恢复', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const run = (await (await request.get(`${api}/runs/${lfgRun}`)).json()) as {
    stages: { lfg: { stages: StageView[] }[] };
  };
  const research = run.stages.lfg[0]?.stages.find((s) => s.stage === 'research');
  if (research?.startSeq == null || research.endSeq == null) throw new Error('research 没有区间');

  await page.goto(`/runs/${lfgRun}`);
  const requests = page.locator('#run-requests');
  await expect(requests.getByTestId('timeline')).toBeVisible();
  await expect(requests.getByTestId('stage-requests')).toHaveCount(0);
  expect(Math.min(...(await visibleSeqs(page)))).toBe(0);

  const stages = page.getByTestId('run-stages');
  await stages.getByTestId('stage-research').click();
  const filtered = requests.getByTestId('stage-requests');
  await expect(filtered.getByRole('heading', { level: 2 })).toHaveText('/lfg · research');
  await expect(filtered).toContainText(
    `主 session 请求 #${String(research.startSeq)} – #${String(research.endSeq)}`,
  );
  await expect(requests.getByTestId('request-row').first()).toBeVisible();
  const seqs = await visibleSeqs(page);
  expect(seqs.length).toBeGreaterThan(0);
  for (const seq of seqs) {
    expect(seq).toBeGreaterThanOrEqual(research.startSeq);
    expect(seq).toBeLessThanOrEqual(research.endSeq);
  }
  await filtered.getByRole('heading', { level: 2 }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/w20-run-stage-filter.png`, animations: 'disabled' });

  // 再次点击同一阶段恢复全部
  await stages.getByTestId('stage-research').click();
  await expect(requests.getByTestId('stage-requests')).toHaveCount(0);
  await expect(requests.getByTestId('timeline')).toBeVisible();
  expect(Math.min(...(await visibleSeqs(page)))).toBe(0);

  // "显示全部"恢复全部
  await stages.getByTestId('stage-plan').click();
  await expect(filtered.getByRole('heading', { level: 2 })).toHaveText('/lfg · plan');
  await filtered.getByRole('button', { name: '显示全部' }).click();
  await expect(requests.getByTestId('stage-requests')).toHaveCount(0);
  expect(Math.min(...(await visibleSeqs(page)))).toBe(0);
});

test('Sessions 详情：对话区显示问答，点击跳到请求明细中的那一行', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/sessions/${f0}`);
  const conversation = page.getByTestId('conversation');
  await expect(conversation.getByTestId('message-user').first()).toContainText(
    '读一下这个项目，分析什么workflow',
  );
  await expect(conversation.getByTestId('message-agent').first()).toContainText('读完了');
  await expect(conversation.getByTestId('message-question')).toHaveCount(7);
  await expect(conversation.getByTestId('message-notice').first()).toBeVisible();

  // 有回答的 AskUserQuestion：选中的选项标出
  const question = conversation
    .getByTestId('message-question')
    .filter({ hasText: '装进哪些 agent' });
  await expect(question.locator('[data-picked="true"]').first()).toHaveText(/三个都装/);
  await question.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/w20-session-conversation.png`, animations: 'disabled' });

  // 点击跳到那一条请求，并展开 AskUserQuestion
  const jump = question.getByTestId('conversation-jump');
  const seq = (await jump.textContent()) ?? '';
  await jump.click();
  const focused = page.locator('[data-testid="request-row"][data-focused="true"]');
  await expect(focused).toHaveCount(1);
  await expect(focused.locator('header')).toContainText(seq);
  await expect(focused.getByTestId('tool-call-detail')).toContainText('三个都装');
  await expect(focused).toBeInViewport();

  // /interview 的用户消息跳到它触发的请求
  const interview = conversation.getByTestId('message-user').filter({ hasText: /^.*\/interview$/ });
  await interview.first().scrollIntoViewIfNeeded();
  const interviewSeq =
    (await interview.first().getByTestId('conversation-jump').textContent()) ?? '';
  await interview.first().getByTestId('conversation-jump').click();
  await expect(focused.locator('header')).toContainText(interviewSeq);
  await expect(focused).toBeInViewport();
});

test('Sessions 详情：选中某个阶段时从对话区跳转，先恢复全部请求再定位', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/sessions/${lfgSession}`);
  const conversation = page.getByTestId('conversation');
  await expect(conversation.getByTestId('message-user').first()).toContainText('/lfg 做一个计算器');
  await page.getByTestId('workflow-lfg').getByTestId('stage-research').click();
  await expect(page.getByTestId('stage-requests')).toBeVisible();
  // 同意计划的回答在 plan 阶段，不在 research 的请求中
  const answer = conversation
    .getByTestId('message-user')
    .filter({ hasText: '可以，这个计划我看了' });
  const jump = answer.getByTestId('conversation-jump');
  const seq = (await jump.textContent()) ?? '';
  await jump.click();
  await expect(page.getByTestId('stage-requests')).toHaveCount(0);
  const focused = page.locator('[data-testid="request-row"][data-focused="true"]');
  await expect(focused).toHaveCount(1);
  await expect(focused.locator('header')).toContainText(seq);
  await expect(focused).toBeInViewport();
});
