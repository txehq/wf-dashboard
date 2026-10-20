import { expect, test } from './test.js';
import { checkWidth, icRuns, lfgRun, shots, widths } from './details-helpers.js';

// Runs 详情（已评分的 lfg run 与两个 ic run）在三种宽度下没有页面级横向滚动
test.describe.configure({ mode: 'serial' });
test.setTimeout(10 * 60_000);

for (const width of widths) {
  test(`${String(width)}px：Runs 详情没有页面级横向滚动`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    for (const run of [lfgRun, ...icRuns]) await checkWidth(page, `/runs/${run}`);
    if (width === 1280) {
      await page.goto(`/runs/${icRuns[1] ?? ''}`);
      await expect(page.getByTestId('timeline')).toBeVisible();
      await page.screenshot({ path: `${shots}/w20-run-1280.png`, animations: 'disabled' });
    }
  });
}
