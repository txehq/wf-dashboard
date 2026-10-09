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

  // 来源勾选：新数据库没有勾选任何目录，列表为空状态，来源列表默认展开
  await expect(page.getByText('在上方勾选来源目录后，这里会列出其中的 session。')).toBeVisible();
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

  // 分析：等待期间显示进度，完成后显示判定花费
  await page.getByRole('button', { name: '分析阶段' }).click();
  await expect(page.getByTestId('analyze-progress')).toBeVisible();
  await page.screenshot({ path: `${shots}/w8-analyzing.png`, animations: 'disabled' });
  await expect(page.getByTestId('checks-cost')).toContainText('次模型调用', { timeout: 600_000 });

  // 汇总区的流程外统计
  const outside = page.getByTestId('outside-stats');
  await expect(outside).toContainText('流程外');
  await expect(outside).toContainText('次请求');
  await page.getByRole('link', { name: '全部 session' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/w8-detail-top.png`, animations: 'disabled' });

  // 两张阶段图：lfg 一轮停在 interview；ic 的前三轮是 PR #72、#77、#78（session 之后的使用可能带来更多轮）
  const lfg = page.getByTestId('workflow-lfg');
  const ic = page.getByTestId('workflow-ic');
  await expect(lfg.getByTestId('stage-interview')).toHaveAttribute('data-status', 'active');
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
  await detail.getByTestId('subagent-jump').click();
  const nested = detail.getByTestId('subagent-rows');
  await expect(nested).toBeVisible();
  await expect(nested.getByTestId('request-row').first()).toContainText('#0');
  await expect(detail.getByTestId('subagent-toggle')).toContainText('56 次请求');
  await nested.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/w8-subagent.png`, animations: 'disabled' });

  // 已分析的状态回到列表
  await page.getByRole('link', { name: '全部 session' }).click();
  await expect(row).toContainText('已分析');
});
