import { expect, test } from './test.js';
import { chooseScope, icRow, lfgRow, openCompare, sectionOf, shot } from './compare-helpers.js';

// Compare 的包含与排除：有人工干预、参考了其他 run、读取了来源、被取消的 run
test.beforeEach(async ({ page }) => {
  await openCompare(page);
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
  await chooseScope(page, '/ic');
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
  await chooseScope(page, '/lfg');
  await expect(toggle).toBeChecked();
  await expect(lfgRow(page).getByTestId('score-cell').first()).toContainText('3 次 run');
  await page.getByRole('checkbox', { name: '包含有人工干预的 run' }).check();
  await expect(lfgRow(page).getByTestId('score-cell').first()).toContainText('4 次 run');

  await chooseScope(page, '/ic');
  await toggle.uncheck();
  await expect(modCell).toContainText('3 次 run');
});

test('包含与排除读取了来源的 run：默认排除，开关放回，点上标出', async ({ page }) => {
  await chooseScope(page, '/ic');
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
