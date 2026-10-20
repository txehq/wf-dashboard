import { checkContrast } from './contrast.js';
import { expect, test } from './test.js';

// 对比度（WCAG AA，明暗两种主题）：chromium 这一对服务上的 Tasks（列表、详情、新建）、Analyses 的列表与新建、
// Compare 的空状态、Runs 的设置与环境检查。Workflows 与 variant 页面见 contrast.spec.ts，Live 的空状态见
// contrast-live-empty.spec.ts
test.setTimeout(180_000);

test('Tasks 列表、详情与新建', async ({ page }) => {
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tasks');
  await expect(page.getByRole('link', { name: /计算器/ }).first()).toBeVisible();
  await checkContrast(page, 'tasks', { screenshot: true });

  await page.goto('/tasks/lfg-calculator');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('计算器');
  await checkContrast(page, 'task-detail', { screenshot: true });

  await page.goto('/tasks/new');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await checkContrast(page, 'task-new');
});

test('Analyses 列表与新建、Compare 的空状态', async ({ page }) => {
  await page.goto('/analyses');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Analyses');
  await checkContrast(page, 'analyses');

  await page.goto('/analyses/new');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await checkContrast(page, 'analysis-new');

  await page.goto('/compare');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Compare');
  await checkContrast(page, 'compare-empty');
});

test('Runs 的设置与环境检查', async ({ page }) => {
  await page.goto('/runs');
  await page.getByTestId('run-settings').locator('summary').click();
  await expect(page.getByTestId('settings-form')).toBeVisible();
  await checkContrast(page, 'runs-settings', { screenshot: true });

  // 基础档中 claude、codex 与 gateway 一律失败：清单中有未通过的项（红色）与通过的项
  const status = page.getByTestId('environment-status');
  await expect(status).toHaveText(/环境：|环境检查失败/, { timeout: 60_000 });
  await status.click();
  const dialog = page.getByTestId('environment-dialog');
  await expect(
    dialog.getByTestId('environment-checks').getByRole('listitem').first(),
  ).toBeVisible();
  await checkContrast(page, 'environment', { screenshot: true });
});
