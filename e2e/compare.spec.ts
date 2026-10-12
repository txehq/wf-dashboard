import { expect, type Locator, type Page, test } from '@playwright/test';

// 数据由 server/scripts/seed-compare-e2e.ts 写入专用数据目录：
// 基线与 "interview 追问边界" 两个 variant × lfg-calculator 与 ic-money-format × 每格 3 次，
// 另有一次有人工干预的基线 lfg run、一次读取了基线 ic run 仓库的 ic run，以及只试跑过一次 lfg 的第三个 variant
// 页面截取视口（选择区与分数表）；某一节截取该节的完整内容。截图前等改选后的数据加载完
const shot = async (target: Page | Locator, name: string) => {
  const page = 'page' in target ? target.page() : target;
  await expect(page.getByTestId('compare-body')).toHaveAttribute('data-refreshing', 'false');
  await target.screenshot({ path: `.work/screenshots/w11-${name}.png`, animations: 'disabled' });
};
const sectionOf = (page: Page, title: string) =>
  page.locator('section', { has: page.getByRole('heading', { level: 2, name: title }) });

const lfgRow = (page: Page) => page.getByTestId('score-row-lfg-calculator');
const icRow = (page: Page) => page.getByTestId('score-row-ic-money-format');

// 对比范围是同一 workflow 的同一大阶段（Contracts 16.5），默认是 dev-workflow/lfg
const chooseScope = async (page: Page, scope: string) => {
  await page.getByTestId('compare-scope').getByRole('radio', { name: scope }).check();
  await expect(page.getByTestId('compare-body')).toHaveAttribute('data-refreshing', 'false');
};

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/compare');
  await expect(page.getByRole('heading', { level: 1, name: 'Compare' })).toBeVisible();
  await expect(page.getByTestId('score-table')).toBeVisible();
});

test('默认选择 dev-workflow/lfg 中全部有 run 的 variant 与 task，基线在第一列', async ({
  page,
}) => {
  await expect(
    page.getByTestId('compare-scope').getByRole('radio', { name: 'dev-workflow/lfg' }),
  ).toBeChecked();
  const head = page.getByTestId('score-table').locator('thead th');
  await expect(head).toHaveText([
    'task',
    '基线 v2.3.0 (dev-workflow)基线',
    'interview 追问边界 (dev-workflow)',
    'plan 先问细节（试跑） (dev-workflow)',
  ]);
  await expect(page.getByRole('checkbox', { name: '课堂用的网页计算器' })).toBeChecked();
  await expect(
    page.getByRole('checkbox', { name: '金额格式化：按币种小数位、负数与大金额' }),
  ).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: '包含有人工干预的 run' })).not.toBeChecked();

  // lfg：基线 3 次（46、44、46 / 84），修改后的 variant 明显更高
  const [baseCell, modCell] = await lfgRow(page).getByTestId('score-cell').all();
  if (baseCell === undefined || modCell === undefined) throw new Error('lfg 行没有两个格子');
  await expect(baseCell.getByTestId('cell-mean')).toHaveText('54% ± 1%');
  await expect(baseCell).toContainText('3 次 run');
  await expect(baseCell.getByTestId('run-dot')).toHaveCount(3);
  await expect(modCell).toContainText('3 次 run');
  await expect(modCell.getByTestId('delta')).toHaveAttribute('data-direction', 'up');
  await expect(modCell.getByTestId('delta')).toHaveAttribute('data-reliable', 'true');
  await shot(page, 'scores');

  // 点击一次 run 打开 Runs 详情
  const dot = baseCell.getByTestId('run-dot').first();
  await expect(dot).toHaveAttribute('href', /^\/runs\/r-20261009-balf0\d$/);
  const href = await dot.getAttribute('href');
  await dot.click();
  await expect(page).toHaveURL(new RegExp(`${String(href)}$`));
});

test('换到 dev-workflow/ic：通过率与到达终点比例，只列出有 ic run 的 variant', async ({ page }) => {
  await chooseScope(page, 'dev-workflow/ic');
  await expect(page.getByTestId('score-table').locator('thead th')).toHaveText([
    'task',
    '基线 v2.3.0 (dev-workflow)基线',
    'interview 追问边界 (dev-workflow)',
  ]);
  await expect(lfgRow(page)).toHaveCount(0);
  const [icBase, icMod] = await icRow(page).getByTestId('score-cell').all();
  if (icBase === undefined || icMod === undefined) throw new Error('ic 行没有两个格子');
  await expect(icBase).toContainText('到达终点 2/3');
  await expect(icMod).toContainText('到达终点 2/3');
  await expect(icMod.getByTestId('delta')).toHaveAttribute('data-direction', 'up');
  await shot(page, 'scores-ic');
});

// Contracts 16.5：按 variant 与模型分组，同一 variant 在不同模型下各占一列
test('按 variant 与模型分组', async ({ page }) => {
  await page
    .getByTestId('compare-group-by')
    .getByRole('radio', { name: '按 variant 与模型' })
    .check();
  const head = page.getByTestId('score-table').locator('thead th');
  await expect(head).toHaveText([
    'task',
    '基线 v2.3.0 (dev-workflow) · opus基线',
    'interview 追问边界 (dev-workflow) · opus',
    'interview 追问边界 (dev-workflow) · sonnet',
    'plan 先问细节（试跑） (dev-workflow) · opus',
  ]);
  const cells = lfgRow(page).getByTestId('score-cell');
  await expect(cells.nth(0)).toContainText('3 次 run');
  await expect(cells.nth(1)).toContainText('2 次 run');
  await expect(cells.nth(2)).toContainText('1 次 run');
  await expect(cells.nth(2).getByTestId('run-dot')).toHaveAttribute(
    'href',
    '/runs/r-20261009-molf02',
  );
  await shot(page, 'group-by-model');

  await page
    .getByTestId('compare-group-by')
    .getByRole('radio', { name: '按 variant', exact: true })
    .check();
  await expect(head).toHaveCount(4);
  await expect(cells.nth(1)).toContainText('3 次 run');
});

test('展开一行看每个产物与每条 rubric 的平均得分', async ({ page }) => {
  await lfgRow(page)
    .getByRole('button', { name: /课堂用的网页计算器/ })
    .click();
  const detail = page.getByTestId('rubric-detail');
  await expect(detail).toBeVisible();
  await expect(detail.locator('tbody tr')).toHaveCount(4 + 26);
  const b6 = detail.locator('tr', { hasText: '逐项列出不做的范围' });
  // 基线三次都是 1 分；修改后为 4、4、3
  await expect(b6.locator('td').nth(1)).toContainText('1.0 / 4');
  await expect(b6.locator('td').nth(2)).toContainText('3.7 / 4');
  await expect(detail.locator('tr', { hasText: 'Brief 得分率' })).toContainText('60%');
  await shot(sectionOf(page, '分数'), 'expanded');

  await chooseScope(page, 'dev-workflow/ic');
  await icRow(page)
    .getByRole('button', { name: /金额格式化/ })
    .click();
  const ic = page.getByTestId('ic-detail');
  await expect(ic).toContainText('r-20261009-baic01');
  await expect(ic).toContainText('未到达终点');
  await expect(ic).toContainText('58% – 84%');
  await shot(sectionOf(page, '分数'), 'expanded-ic');
});

test('包含与排除有人工干预的 run', async ({ page }) => {
  const baseCell = lfgRow(page).getByTestId('score-cell').first();
  await expect(baseCell).toContainText('3 次 run');
  const toggle = page.getByRole('checkbox', { name: '包含有人工干预的 run' });
  await expect(page.getByTestId('intervened-count')).toHaveText('选中范围内有 1 次');

  await toggle.check();
  await expect(baseCell).toContainText('4 次 run');
  await expect(baseCell.getByTestId('run-dot')).toHaveCount(4);
  await expect(
    baseCell.getByRole('link', { name: 'run r-20261009-balf03：63.1%，有人工干预' }),
  ).toBeVisible();
  await expect(baseCell.getByTestId('cell-mean')).toHaveText('56% ± 5%');
  await shot(page, 'intervened');

  await toggle.uncheck();
  await expect(baseCell).toContainText('3 次 run');
  await expect(baseCell.getByTestId('cell-mean')).toHaveText('54% ± 1%');
});

test('包含与排除参考了其他 run 的 run：菱形点，与人工干预的开关互不影响', async ({ page }) => {
  await chooseScope(page, 'dev-workflow/ic');
  const modCell = icRow(page).getByTestId('score-cell').nth(1);
  await expect(modCell).toContainText('3 次 run');
  const toggle = page.getByRole('checkbox', { name: '包含参考了其他 run 的 run' });
  await expect(toggle).not.toBeChecked();
  await expect(page.getByTestId('cross-ref-count')).toHaveText('选中范围内有 1 次');

  await toggle.check();
  await expect(modCell).toContainText('4 次 run');
  const crossDot = modCell.getByRole('link', {
    name: 'run r-20261009-moic03：100.0%，参考了其他 run',
  });
  await expect(crossDot).toHaveAttribute('data-cross-ref', 'true');
  await expect(modCell.locator('[data-testid="run-dot"][data-cross-ref="true"]')).toHaveCount(1);
  await crossDot.hover();
  await page.screenshot({ path: '.work/screenshots/w13-compare.png', animations: 'disabled' });

  // 换范围时开关保留；人工干预的 run 仍被排除
  await chooseScope(page, 'dev-workflow/lfg');
  await expect(toggle).toBeChecked();
  await expect(lfgRow(page).getByTestId('score-cell').first()).toContainText('3 次 run');
  await page.getByRole('checkbox', { name: '包含有人工干预的 run' }).check();
  await expect(lfgRow(page).getByTestId('score-cell').first()).toContainText('4 次 run');

  await chooseScope(page, 'dev-workflow/ic');
  await toggle.uncheck();
  await expect(modCell).toContainText('3 次 run');
});

test('包含与排除读取了来源的 run：默认排除，开关放回，点上标出', async ({ page }) => {
  await chooseScope(page, 'dev-workflow/ic');
  const baseCell = icRow(page).getByTestId('score-cell').first();
  await expect(baseCell).toContainText('3 次 run');
  const toggle = page.getByRole('checkbox', { name: '包含读取了来源工单或仓库的 run' });
  await expect(toggle).not.toBeChecked();
  await expect(page.getByTestId('source-ref-count')).toHaveText('选中范围内有 1 次');

  await toggle.check();
  await expect(baseCell).toContainText('4 次 run');
  const sourceDot = baseCell.locator('[data-testid="run-dot"][data-source-ref="true"]');
  await expect(sourceDot).toHaveCount(1);
  await expect(sourceDot).toHaveAttribute('aria-label', /r-20261009-baic04.*读取了来源工单或仓库/);
  await sourceDot.hover();
  await page.screenshot({ path: '.work/screenshots/w29-compare.png', animations: 'disabled' });

  await toggle.uncheck();
  await expect(baseCell).toContainText('3 次 run');
});

test('运行详情的"读取了来源工单 / 仓库"区块：每处的种类、请求编号与摘录', async ({ page }) => {
  await page.goto('/runs/r-20261009-baic04');
  const block = page.getByTestId('source-refs');
  await expect(block).toContainText('读取了来源工单 / 仓库');
  await expect(block).toContainText('对比时默认排除；共 2 处');
  const items = block.getByRole('listitem');
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText('来源工单');
  await expect(items.nth(0)).toContainText('请求 #4');
  await expect(items.nth(0)).toContainText('id: TXE-3635');
  await expect(items.nth(1)).toContainText('来源 PR');
  await expect(items.nth(1)).toContainText('gh pr view 638 --repo txehq/tokun-cn');
  await block.screenshot({ path: '.work/screenshots/w29-source-refs.png', animations: 'disabled' });

  await page.goto('/runs');
  const row = page.locator('[data-run="r-20261009-baic04"]');
  await expect(row.getByTestId('source-ref')).toHaveText('读取了来源');
});

test('包含与排除被取消的 run：三角形点，产物并排可以选它', async ({ page }) => {
  const baseCell = lfgRow(page).getByTestId('score-cell').first();
  await expect(baseCell).toContainText('3 次 run');
  const toggle = page.getByRole('checkbox', { name: '包含被取消的 run' });
  await expect(toggle).not.toBeChecked();
  await expect(page.getByTestId('cancelled-count')).toContainText('选中范围内有 1 次');
  const section = sectionOf(page, '产物并排');
  await expect(section.getByLabel('左').locator('option[value="r-20261009-balf04"]')).toHaveCount(
    0,
  );

  await toggle.check();
  await expect(baseCell).toContainText('4 次 run');
  const dot = baseCell.locator('[data-testid="run-dot"][data-cancelled="true"]');
  await expect(dot).toHaveCount(1);
  await expect(dot).toHaveAttribute('aria-label', /r-20261009-balf04.*被取消，按已写出的产物评分/);
  await expect(dot.locator('polygon')).toHaveCount(1);
  await section.getByLabel('左').selectOption('r-20261009-balf04');
  await expect(section.getByTestId('rubric-side-by-side')).toBeVisible();
  await dot.hover();
  await shot(page, 'cancelled');

  await toggle.uncheck();
  await expect(baseCell).toContainText('3 次 run');
});

test('只有一次 run 的差值标为不可信，没有 run 的格子，切换基线与取消 task', async ({ page }) => {
  const trialCell = lfgRow(page).getByTestId('score-cell').nth(2);
  await expect(trialCell).toContainText('1 次 run');
  await expect(trialCell.getByTestId('cell-mean')).not.toContainText('±');
  await expect(trialCell.getByTestId('delta')).toHaveAttribute('data-reliable', 'false');
  await expect(trialCell.getByTestId('delta')).toContainText('run 少于 2 次，差值不可信');

  // 取消试跑的 variant
  await page.getByRole('checkbox', { name: /plan 先问细节/ }).uncheck();
  await expect(icRow(page)).toHaveCount(0);
  await expect(lfgRow(page).getByTestId('score-cell')).toHaveCount(2);

  // 设修改后的 variant 为基线，列顺序随之改变
  await page.getByRole('button', { name: '设为基线' }).click();
  const head = page.getByTestId('score-table').locator('thead th');
  await expect(head).toHaveText([
    'task',
    'interview 追问边界 (dev-workflow)基线',
    '基线 v2.3.0 (dev-workflow)',
  ]);
  const baseCell = lfgRow(page).getByTestId('score-cell').nth(1);
  await expect(baseCell.getByTestId('delta')).toHaveAttribute('data-direction', 'down');
  await shot(page, 'selection');
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

  await chooseScope(page, 'dev-workflow/ic');
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

  await chooseScope(page, 'dev-workflow/ic');
  await section.getByRole('radio', { name: '表' }).click();
  // ic 7 个阶段 × 2 个 variant（试跑的 variant 没有 ic run，不在这个范围中）；有一次 run 未到达 ready-for-review
  await expect(table.locator('tbody tr')).toHaveCount(14);
  await expect(table.locator('tr', { hasText: 'ready-for-review' }).first()).toContainText('2/3');
  await expect(breakdownCaption(section, '合计')).toBeVisible();
  await section.getByRole('radio', { name: '图' }).click();
  await expect(chart.locator('.recharts-bar-rectangle')).toHaveCount(14);
  await shot(section, 'costs-ic');
});

function breakdownCaption(section: ReturnType<Page['locator']>, text: string) {
  return section.getByTestId('cost-breakdown').locator('figcaption', { hasText: text });
}

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
  await section.getByLabel('旧').selectOption({ label: 'interview 追问边界 (dev-workflow)' });
  await section.getByLabel('新').selectOption({ label: '基线 v2.3.0 (dev-workflow)' });
  await expect(section.getByText('2 个文件不同')).toBeVisible();
  await expect(diff.locator('.original .view-lines')).toContainText('Boundaries are asked');
});

// Contracts 7.9（W18c）：agent 的代码让隐藏测试没能运行时，评分照常完成，运行详情的评分区显示原因与原文
test('运行详情的评分区显示隐藏测试没能运行的原因', async ({ page }) => {
  await page.goto('/runs/r-20261009-baic03');
  const grades = page.getByTestId('run-grades');
  await expect(grades).toContainText('0 / 19');
  const error = grades.getByTestId('grade-error');
  await expect(error).toContainText('隐藏测试没有正常运行，测试记 0 分');
  await expect(error).toContainText('npm ci 退出码 1：npm error code EINTEGRITY');
  await page.screenshot({ path: '.work/screenshots/w18c-grade-error.png', animations: 'disabled' });
});
