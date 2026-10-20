// 测 Sessions 页面在浏览器中的加载时间：从导航开始到第一行出现、到第一页全部渲染完成。
// 用法：pnpm --filter @wf-dashboard/server exec tsx scripts/measure-sessions-page.ts http://127.0.0.1:5216
import { chromium } from '@playwright/test';

const base = process.argv[2];
if (base === undefined) throw new Error('用法：measure-sessions-page.ts <页面地址>');

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
// 第一次打开包含 Vite 的模块编译，只作预热
await page.goto(`${base}/sessions`);
await page.getByTestId('session-row').first().waitFor();

for (let i = 0; i < 3; i++) {
  const start = performance.now();
  await page.goto(`${base}/sessions`);
  await page.getByTestId('session-row').first().waitFor();
  const firstRow = performance.now() - start;
  const rows = await page.getByTestId('session-row').count();
  const more = await page.getByRole('button', { name: '加载更多' }).isVisible();
  console.log(
    `第 ${String(i + 1)} 次：第一行出现 ${String(Math.round(firstRow))} ms，第一页 ${String(rows)} 行${more ? '，有"加载更多"' : ''}`,
  );
}
await browser.close();
