import { checkContrast } from './contrast.js';
import { expect, test } from './test.js';

// 对比度（WCAG AA，明暗两种主题）：runs 这一对服务（导入的 W4 端到端 run）上的 Sessions 列表与详情（阶段图、
// 点开阶段的请求与展开的 tool 调用）、Runs 列表与 lfg、ic 两个 run 的详情（对话、产物、评分）
const icSession = 'ba7cdc89-21ef-4b94-83aa-05073ed3d25f';
test.setTimeout(180_000);

test('Sessions 列表与详情', async ({ page }) => {
  await page.goto('/sessions');
  await expect(page.getByTestId('session-row').first()).toBeVisible();
  await checkContrast(page, 'sessions', { screenshot: true });

  await page.goto(`/sessions/${icSession}`);
  await expect(page.getByTestId('workflow-ic')).toBeVisible();
  await expect(page.getByTestId('timeline').first()).toBeVisible({ timeout: 60_000 });
  await page.locator('[data-testid^="stage-"][data-status="done"]').first().click();
  await expect(page.getByTestId('stage-requests')).toBeVisible();
  const tools = page.getByTestId('tool-call').locator('> button');
  for (let i = Math.min(await tools.count(), 3) - 1; i >= 0; i--) await tools.nth(i).click();
  await checkContrast(page, 'session-detail', { screenshot: true });
});

test('Runs 列表与详情', async ({ page }) => {
  await page.goto('/runs');
  await expect(page.getByRole('link', { name: /r-20261009-dqva52|课堂用的网页计算器/ }).first()).toBeVisible();
  await checkContrast(page, 'runs', { screenshot: true });

  await page.goto('/runs/r-20261009-dqva52');
  await expect(page.getByTestId('run-grades')).toContainText('合计');
  const artifacts = page.getByTestId('run-artifacts');
  await artifacts.getByRole('tab', { name: /Brief/ }).click();
  await expect(artifacts.getByTestId('artifact-markdown').locator('h1').first()).toBeVisible();
  await checkContrast(page, 'run-lfg', { screenshot: true });

  await page.goto('/runs/r-20261009-a26chw');
  await expect(page.getByTestId('timeline')).toBeVisible();
  await checkContrast(page, 'run-ic', { screenshot: true });
});
