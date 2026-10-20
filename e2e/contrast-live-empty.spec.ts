import { checkContrast } from './contrast.js';
import { expect, test } from './test.js';

// Live 的空状态的对比度（WCAG AA，明暗两种主题）：在 compare 这一对服务上检查。它的种子数据中没有交互项，
// 这个 project 的用例也不启动交互项；chromium 那一对服务上的 workflows、codex-drafts 会启动交互项
test('Live 的空状态', async ({ page }) => {
  await page.goto('/live');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Live');
  await expect(page.getByText('还没有交互 session。')).toBeVisible();
  await checkContrast(page, 'live-empty');
});
