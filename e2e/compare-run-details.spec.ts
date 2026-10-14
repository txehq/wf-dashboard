import { expect, test } from './test.js';
import { openCompare } from './compare-helpers.js';

// 从 Compare 的种子数据打开的运行详情：读取了来源的区块与评分区的错误原因
test.beforeEach(async ({ page }) => {
  await openCompare(page);
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
