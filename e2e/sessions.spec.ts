import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';

// 真实数据：本机 ~/.claude/projects 中含 f0aca373 样本的目录；e2e 服务端使用每次重建的数据库
const sourcePath = path.join(
  os.homedir(),
  '.claude/projects/-Users-linhaoz-Project-txe-txe-workflow',
);
const sessionId = 'f0aca373-863f-4d62-babd-f48055092328';
const shots = '.work/screenshots';

test('Sessions：来源勾选、列表、详情、阶段判定、阶段请求、tool 调用与子代理', async ({
  page,
  request,
}) => {
  // 判定 f0aca373 需要数百次真实模型调用
  test.setTimeout(900_000);

  await page.goto('/sessions');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sessions');

  // 来源勾选：新数据库没有勾选任何 ~/.claude/projects 目录，列表为空状态，来源列表默认展开。
  // 数据目录中有 variant 时，它们的 session 目录总是勾选（Contracts 5），空状态换成另一句
  await expect(
    page
      .getByText('在上方勾选来源目录后，这里会列出其中的 session。')
      .or(page.getByText('勾选的目录中还没有 session。')),
  ).toBeVisible();
  // 已有勾选的目录时来源列表默认折叠
  const sourcesToggle = page.getByRole('region', { name: '来源目录' }).getByRole('button').first();
  if ((await sourcesToggle.getAttribute('aria-expanded')) === 'false') await sourcesToggle.click();
  const checkbox = page.getByRole('checkbox', { name: sourcePath, exact: true });
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await expect(page.getByTestId('import-result')).toContainText('已导入');
  await expect(checkbox).toBeChecked();

  // 列表：f0aca373 是本机仍在使用的 session，请求数以导入后 API 的值为准
  const row = page.getByTestId('session-row').filter({ hasText: sessionId.slice(0, 8) });
  await expect(row).toBeVisible();
  const detailJson = (await (await request.get(`/api/sessions/${sessionId}`)).json()) as {
    requestCount: number;
    costUsd: number;
  };
  const requestCount = detailJson.requestCount.toLocaleString('en-US');
  expect(detailJson.requestCount).toBeGreaterThanOrEqual(1297);
  await expect(row).toContainText('读一下这个项目，分析什么workflow');
  await expect(row).toContainText(requestCount);
  await expect(row).toContainText('/lfg');
  await expect(row).toContainText('/ic');
  await expect(row).toContainText('未分析');
  await page.getByRole('button', { name: /来源目录/ }).click();
  await page.screenshot({ path: `${shots}/w8-list.png`, fullPage: true, animations: 'disabled' });

  // 搜索与 workflow 筛选
  await page.getByRole('searchbox', { name: '搜索 session' }).fill('f0aca373');
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  await page.getByRole('radio', { name: '/ic' }).click();
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  await page.getByRole('searchbox', { name: '搜索 session' }).fill('不存在的标题');
  await expect(page.getByText('没有符合条件的 session。')).toBeVisible();
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(row).toBeVisible();

  // 详情顶部
  await row.getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}$`));
  const summary = page.getByTestId('session-summary');
  await expect(summary.getByRole('heading', { level: 1 })).toHaveText(
    '读一下这个项目，分析什么workflow',
  );
  await expect(summary).toContainText(requestCount);
  await expect(summary).toContainText(`$${Math.round(detailJson.costUsd).toLocaleString('en-US')}`);
  await expect(summary.getByRole('figure', { name: '各 tool 的调用次数' })).toContainText('Bash');
  await expect(page.getByRole('button', { name: '分析阶段' })).toBeVisible();
  await expect(page.getByTestId('outside-stats')).toHaveCount(0);

  // 分析：后台逐批判定，页面显示已判定批数与已花费；离开页面再回来时显示当前进度；完成后自动显示结果
  await page.getByRole('button', { name: '分析阶段' }).click();
  const progress = page.getByTestId('analyze-progress');
  await expect(progress).toBeVisible();
  await page.screenshot({ path: `${shots}/w8-analyzing.png`, animations: 'disabled' });
  const seen = new Set<string>();
  const batchesDone = async () => {
    // 不等待元素：判定完成后进度框消失
    const values = await progress.evaluateAll((els) =>
      els.map((el) => el.getAttribute('data-batches-done') ?? ''),
    );
    const value = values[0] ?? '';
    if (value !== '') seen.add(value);
    return Number(value === '' ? '-1' : value);
  };
  await expect.poll(batchesDone, { timeout: 120_000, intervals: [200] }).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('analyze-batches')).toContainText('批 · 已花费 $');
  await progress.screenshot({ path: `${shots}/w16-progress.png`, animations: 'disabled' });

  await page.getByRole('link', { name: '全部 session' }).click();
  await expect(row).toBeVisible();
  const left = Math.max(...[...seen].map(Number));
  await row.getByRole('link').click();
  await expect(progress).toBeVisible();
  await expect.poll(batchesDone, { timeout: 120_000, intervals: [200] }).toBeGreaterThan(left);

  // 判定中每 200ms 记录一次已判定批数，直到结果自动出现
  const checksCost = page.getByTestId('checks-cost');
  while (!(await checksCost.isVisible())) {
    await batchesDone();
    await page.waitForTimeout(200);
  }
  expect(seen.size).toBeGreaterThanOrEqual(2);
  await expect(checksCost).toContainText('次模型调用');

  // 汇总区的流程外统计
  const outside = page.getByTestId('outside-stats');
  await expect(outside).toContainText('流程外');
  await expect(outside).toContainText('次请求');
  await page.getByRole('link', { name: '全部 session' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/w8-detail-top.png`, animations: 'disabled' });

  // 两张阶段图：lfg 一轮停在 interview；ic 的前三轮是 PR #72、#77、#78（session 之后的使用可能带来更多轮）
  const lfg = page.getByTestId('workflow-lfg');
  const ic = page.getByTestId('workflow-ic');
  // lfg 一轮在 ic 第 1 轮开始前结束：interview 为中断，并说明后来开始了另一轮流程
  await expect(lfg.getByTestId('stage-interview')).toHaveAttribute('data-status', 'interrupted');
  await expect(lfg.getByTestId('stage-interview')).toContainText('中断');
  await expect(lfg.getByTestId('stage-interview')).toContainText('后来开始了另一轮流程');
  await expect(lfg.getByTestId('stage-research')).toHaveAttribute('data-status', 'not-reached');
  await expect(lfg.getByTestId('stage-dispatch-gate')).toContainText('未到达');
  const tabs = ic.getByTestId('cycles-ic').getByRole('tab');
  await expect(tabs.nth(2)).toBeVisible();
  await expect(tabs.nth(0)).toContainText('PR #72');
  await expect(tabs.nth(1)).toContainText('PR #77');
  await expect(tabs.nth(2)).toContainText('PR #78');
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  const expectCycleStatuses = async () => {
    for (const stage of ['open-pr', 'fix-pr', 'ready-for-review'])
      await expect(ic.getByTestId(`stage-${stage}`)).toHaveAttribute('data-status', 'done');
    for (const stage of ['claim', 'acceptance'])
      await expect(ic.getByTestId(`stage-${stage}`)).toHaveAttribute('data-status', 'skipped');
  };
  await expectCycleStatuses();
  await expect(ic.getByTestId('stage-acceptance')).toContainText('跳过');
  await expect(ic.getByText('各阶段花费')).toBeVisible();
  await expect(ic.getByText('各阶段耗时')).toBeVisible();
  await lfg.screenshot({ path: `${shots}/w8-lfg-graph.png`, animations: 'disabled' });

  // 切换到第 2 轮（PR #77）
  await tabs.nth(1).click();
  await expect(page).toHaveURL(/ic=2/);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expectCycleStatuses();
  await ic.screenshot({ path: `${shots}/w8-ic-graph.png`, animations: 'disabled' });
  await tabs.nth(0).click();
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');

  // 点击第 1 轮的 open-pr：只列出该阶段的请求，证据是 Skill open-pr
  await ic.getByTestId('stage-open-pr').click();
  await expect(page).toHaveURL(/stage=ic%3Aopen-pr/);
  const detail = page.getByTestId('stage-detail');
  await expect(detail.getByRole('heading', { level: 2 })).toHaveText('/ic · open-pr');
  await expect(detail.getByTestId('stage-cycle')).toHaveText('第 1 轮 · PR #72');
  await expect(detail).toContainText('Skill: open-pr');
  await expect(detail).toContainText('#549 – #556');
  await expect(detail.getByTestId('request-row').first()).toContainText('#549');
  await expect(detail).toContainText('8 次请求 ·');

  // 点击 fix-pr，展开一个 tool 调用
  await ic.getByTestId('stage-fix-pr').click();
  await expect(detail.getByRole('heading', { level: 2 })).toHaveText('/ic · fix-pr');
  await expect(detail).toContainText('Skill: fix-pr https://github.com/txehq/txe-workflow/pull/72');
  const firstRequest = detail.getByTestId('request-row').first();
  await expect(firstRequest).toContainText('#557');
  const toolCall = firstRequest.getByTestId('tool-call').first();
  await toolCall.getByRole('button').first().click();
  const toolDetail = toolCall.getByTestId('tool-call-detail');
  await expect(toolDetail).toContainText('参数');
  await expect(toolDetail).toContainText('"skill": "fix-pr"');
  await expect(toolDetail).toContainText('结果');
  await detail.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/w8-requests.png`, animations: 'disabled' });

  // 子代理：lfg interview 阶段中的 Agent 调用，展开后嵌套显示子代理的请求行
  await lfg.getByTestId('stage-interview').click();
  await expect(detail.getByRole('heading', { level: 2 })).toHaveText('/lfg · interview');
  await expect(detail.getByTestId('stage-interrupted')).toContainText('后来开始了另一轮流程');
  await detail.getByTestId('subagent-jump').click();
  const nested = detail.getByTestId('subagent-rows');
  await expect(nested).toBeVisible();
  await expect(nested.getByTestId('request-row').first()).toContainText('#0');
  await expect(detail.getByTestId('subagent-toggle')).toContainText('56 次请求');
  await nested.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/w8-subagent.png`, animations: 'disabled' });

  // 1280px 宽：lfg 与 ic 的阶段框全部显示，页面与阶段图都没有横向滚动；ic 换成两行
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByTestId('stage-requests').getByRole('button', { name: '显示全部' }).click();
  const noHorizontalScroll = async (selector: string) =>
    page.locator(selector).evaluate((el) => el.scrollWidth <= el.clientWidth);
  await expect.poll(() => noHorizontalScroll('html')).toBe(true);
  for (const workflow of ['lfg', 'ic'] as const) {
    const graph = page.getByTestId(`stage-graph-${workflow}`);
    await expect.poll(() => graph.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    const box = await graph.boundingBox();
    if (box === null) throw new Error(`${workflow} 阶段图不可见`);
    const stages = graph.locator('[data-testid^="stage-"]');
    for (const stage of await stages.all()) {
      await expect(stage).toBeVisible();
      const b = await stage.boundingBox();
      if (b === null) throw new Error('阶段框不可见');
      expect(b.x).toBeGreaterThanOrEqual(box.x);
      expect(b.x + b.width).toBeLessThanOrEqual(box.x + box.width);
    }
  }
  await expect(page.getByTestId('stage-graph-lfg')).toHaveAttribute('data-rows', '1');
  await expect(page.getByTestId('stage-graph-ic')).toHaveAttribute('data-rows', '2');
  await expect(ic.getByTestId('stage-ready-for-review')).toContainText('请求');
  await lfg.scrollIntoViewIfNeeded();
  const lfgBox = await lfg.boundingBox();
  const icBox = await ic.boundingBox();
  if (lfgBox === null || icBox === null) throw new Error('阶段图区域不可见');
  // boundingBox 相对视口，fullPage 截图的 clip 相对页面
  const scrollY = await page.locator('html').evaluate((el) => el.scrollTop);
  await page.screenshot({
    path: `${shots}/w16-graph-1280.png`,
    fullPage: true,
    animations: 'disabled',
    clip: {
      x: Math.min(lfgBox.x, icBox.x),
      y: lfgBox.y + scrollY,
      width: Math.max(lfgBox.width, icBox.width),
      height: icBox.y + icBox.height - lfgBox.y,
    },
  });

  // 已分析的状态回到列表
  await page.getByRole('link', { name: '全部 session' }).click();
  await expect(row).toContainText('已分析');
});
