import { expect, test } from './test.js';
import { chooseScope, icRow, lfgRow, openCompare, sectionOf, shot } from './compare-helpers.js';

// Compare 的分数表：默认选择、换范围、分组、展开一行、差值的可信度与切换基线
test.beforeEach(async ({ page }) => {
  await openCompare(page);
});

test('默认选择 /lfg 中全部有 run 的 variant 与 task，基线在第一列', async ({ page }) => {
  await expect(
    page.getByTestId('compare-scope').getByRole('radio', { name: '/lfg' }),
  ).toBeChecked();
  const head = page.getByTestId('score-table').locator('thead th');
  await expect(head).toHaveText([
    'task',
    '基线 v2.3.0 (lfg)基线',
    'interview 追问边界 (lfg)',
    'plan 先问细节（试跑） (lfg)',
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

test('换到 /ic：通过率与到达终点比例，只列出有 ic run 的 variant', async ({ page }) => {
  await chooseScope(page, '/ic');
  await expect(page.getByTestId('score-table').locator('thead th')).toHaveText([
    'task',
    '基线 v2.3.0 (ic)基线',
    'interview 追问边界 (ic)',
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
    '基线 v2.3.0 (lfg) · opus基线',
    'interview 追问边界 (lfg) · opus',
    'interview 追问边界 (lfg) · sonnet',
    'plan 先问细节（试跑） (lfg) · opus',
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

  await chooseScope(page, '/ic');
  await icRow(page)
    .getByRole('button', { name: /金额格式化/ })
    .click();
  const ic = page.getByTestId('ic-detail');
  await expect(ic).toContainText('r-20261009-baic01');
  await expect(ic).toContainText('未到达终点');
  await expect(ic).toContainText('58% – 84%');
  await shot(sectionOf(page, '分数'), 'expanded-ic');
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
  await expect(head).toHaveText(['task', 'interview 追问边界 (lfg)基线', '基线 v2.3.0 (lfg)']);
  const baseCell = lfgRow(page).getByTestId('score-cell').nth(1);
  await expect(baseCell.getByTestId('delta')).toHaveAttribute('data-direction', 'down');
  await shot(page, 'selection');
});
