import { expect, test } from './test.js';
import { checkWidth, runSessions, shots, widths } from './details-helpers.js';

// Sessions 详情（lfg run 与 ic run 的 session）在三种宽度下没有页面级横向滚动
test.describe.configure({ mode: 'serial' });
test.setTimeout(10 * 60_000);

let lfgSession = '';
let icSession = '';

test.beforeAll(async ({ request }) => {
  ({ lfgSession, icSession } = await runSessions(request));
});

for (const width of widths) {
  test(`${String(width)}px：Sessions 详情没有页面级横向滚动`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    for (const url of [`/sessions/${icSession}`, `/sessions/${lfgSession}`]) {
      await checkWidth(page, url);
    }
    if (width === 1280) {
      await page.goto(`/sessions/${icSession}`);
      await expect(page.getByTestId('workflow-ic')).toBeVisible();
      await page.screenshot({ path: `${shots}/w20-session-1280.png`, animations: 'disabled' });
    }
  });
}
