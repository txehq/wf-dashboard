import { expect, test } from './test.js';
import { checkContrast } from './contrast.js';
import {
  breakdownCaption,
  chooseScope,
  icRow,
  lfgRow,
  openCompare,
  sectionOf,
  shot,
} from './compare-helpers.js';

// Compare 中分数表以下的几节：产物并排、各阶段成本、skill 内容 diff，以及整页的对比度
test.beforeEach(async ({ page }) => {
  await openCompare(page);
});

test('产物并排：lfg 的 rubric 得分、理由与 markdown；ic 的 PR、测试明细与终点', async ({
  page,
}) => {
  const section = sectionOf(page, '产物并排');
  await expect(section.getByLabel('左')).toHaveValue('r-20261009-balf00');
  await expect(section.getByLabel('右')).toHaveValue('r-20261009-molf00');
  const rubric = section.getByTestId('rubric-side-by-side');
  const b2 = rubric.locator('tr', { hasText: '完全离线可用' });
  await expect(b2.locator('td').nth(1)).toContainText('2 / 5');
  await expect(b2.locator('td').nth(1)).toContainText('只有"页面要能离线打开"一句');
  await expect(b2.locator('td').nth(2)).toContainText('5 / 5');
  const panes = section.getByTestId('artifact-markdown');
  await expect(panes).toHaveCount(2);
  await expect(
    panes.nth(1).getByRole('heading', { name: 'Brief：课堂用的网页计算器' }),
  ).toBeVisible();
  await expect(panes.nth(1).getByRole('table')).toContainText('机房（Win7 + Chrome 109）和家里');
  await shot(section, 'artifacts-brief');

  await section.getByRole('tab', { name: 'Tickets' }).click();
  await expect(rubric).toContainText('dispatch gate');
  await expect(panes.nth(0)).toContainText('TXE-3101');
  await expect(panes.nth(1)).toContainText('TXE-3204');

  // 左边换成同一 variant 的另一次 run
  await section.getByLabel('左').selectOption('r-20261009-balf02');
  await expect(
    rubric.locator('tr', { hasText: '可验证的验收标准' }).locator('td').nth(1),
  ).toContainText('1 / 4');
  await shot(section, 'artifacts-tickets');

  await chooseScope(page, '/ic');
  await expect(section.getByLabel('产物并排的 task')).toHaveValue('ic-money-format');
  await expect(section.getByLabel('左')).toHaveValue('r-20261009-baic00');
  await expect(section.getByLabel('右')).toHaveValue('r-20261009-moic00');
  const summaries = section.getByTestId('ic-summary');
  await expect(summaries.nth(0)).toContainText('14 / 19 通过');
  await expect(summaries.nth(1)).toContainText('17 / 19 通过');
  await expect(summaries.nth(0).getByRole('link', { name: /PR #1/ })).toHaveAttribute(
    'href',
    'https://github.com/txehq/wfe-r-20261009-baic00/pull/1',
  );
  await section.getByLabel('右').selectOption('r-20261009-moic02');
  await expect(summaries.nth(1)).toContainText('未到达');
  await expect(summaries.nth(1)).toContainText('缺少必需检查：test');
  const tests = section.getByTestId('ic-tests');
  await expect(tests.locator('tbody tr')).toHaveCount(19);
  await expect(
    tests.locator('tr', { hasText: 'unsafe integers throw TypeError' }).locator('td').nth(1),
  ).toHaveText('失败');
  await shot(section, 'artifacts-ic');
});

test('各阶段成本：分组条形图、指标切换、表格与三项成本', async ({ page }) => {
  const section = sectionOf(page, '各阶段成本');
  const chart = section.getByTestId('stage-cost-chart');
  // lfg 4 个阶段 × 3 个 variant
  await expect(chart.locator('.recharts-bar-rectangle')).toHaveCount(12);
  await expect(chart).toContainText('interview');
  await expect(chart).toContainText('ticketing');
  await expect(section.getByRole('list', { name: '图例' })).toContainText('interview 追问边界');
  const breakdown = section.getByTestId('cost-breakdown');
  for (const part of ['agent', '模拟用户', '评分', '合计']) {
    await expect(breakdown.locator('figcaption', { hasText: part })).toBeVisible();
  }
  await expect(breakdown.locator('figcaption', { hasText: '阶段判定' })).toHaveCount(0);
  await shot(section, 'costs');

  await chart.locator('.recharts-bar-rectangle').first().hover();
  await expect(chart.locator('.recharts-tooltip-wrapper')).toContainText('到达 3/3 次');

  await section.getByRole('radio', { name: 'token' }).click();
  await expect(section.getByRole('heading', { name: '各阶段平均token（每次 run）' })).toBeVisible();
  await section.getByRole('radio', { name: '表' }).click();
  const table = section.getByTestId('stage-cost-table');
  await expect(table.locator('tbody tr')).toHaveCount(12);

  await chooseScope(page, '/ic');
  await section.getByRole('radio', { name: '表' }).click();
  // ic 7 个阶段 × 2 个 variant（试跑的 variant 没有 ic run，不在这个范围中）；有一次 run 未到达 ready-for-review
  await expect(table.locator('tbody tr')).toHaveCount(14);
  await expect(table.locator('tr', { hasText: 'ready-for-review' }).first()).toContainText('2/3');
  await expect(breakdownCaption(section, '合计')).toBeVisible();
  await section.getByRole('radio', { name: '图' }).click();
  await expect(chart.locator('.recharts-bar-rectangle')).toHaveCount(14);
  await shot(section, 'costs-ic');
});

test('skill 内容 diff：两个 variant 逐文件对比', async ({ page }) => {
  const section = sectionOf(page, 'skill 内容 diff');
  await expect(section.getByText('2 个文件不同')).toBeVisible();
  await expect(section.getByRole('button', { name: /skills\/interview\/SKILL\.md/ })).toBeVisible();
  const diff = section.getByTestId('skill-diff');
  await expect(diff.locator('.modified .view-lines')).toContainText('Boundaries are asked');
  await expect(diff.locator('.line-insert').first()).toBeVisible();
  await section.getByRole('button', { name: /skills\/research\/SKILL\.md/ }).click();
  await expect(diff.locator('.modified .view-lines')).toContainText('cited source');
  await shot(section, 'skill-diff');

  // 反过来比较，新增变为删除
  await section.getByLabel('旧').selectOption({ label: 'interview 追问边界 (lfg)' });
  await section.getByLabel('新').selectOption({ label: '基线 v2.3.0 (lfg)' });
  await expect(section.getByText('2 个文件不同')).toBeVisible();
  await expect(diff.locator('.original .view-lines')).toContainText('Boundaries are asked');
});

// 对比度（WCAG AA，明暗两种主题）：整页（分数表、展开的一行、产物并排、各阶段成本、skill 内容 diff），/lfg 与 /ic
test('对比度：Compare 的 /lfg 与 /ic 达到 WCAG AA，明暗两种主题', async ({ page }) => {
  await lfgRow(page)
    .getByRole('button', { name: /课堂用的网页计算器/ })
    .click();
  await expect(page.getByTestId('rubric-detail')).toBeVisible();
  await expect(sectionOf(page, 'skill 内容 diff').getByText('2 个文件不同')).toBeVisible();
  await expect(page.getByTestId('compare-body')).toHaveAttribute('data-refreshing', 'false');
  await checkContrast(page, 'compare-lfg', { screenshot: true });
  await chooseScope(page, '/ic');
  await expect(icRow(page)).toBeVisible();
  await checkContrast(page, 'compare-ic', { screenshot: true });
});
