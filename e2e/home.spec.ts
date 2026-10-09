import { expect, test } from '@playwright/test';
import { serverPort } from '../ports.js';

const pages = ['Sessions', 'Runs', 'Variants', 'Tasks', 'Compare'];

test('服务端健康检查返回 ok', async ({ request }) => {
  const response = await request.get(`http://127.0.0.1:${String(serverPort)}/api/health`);
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ status: 'ok' });
});

test('首页显示五个导航页面并经代理连上服务端', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/sessions$/);

  const nav = page.getByRole('navigation', { name: '主导航' });
  await expect(nav.getByRole('link')).toHaveText(pages);
  await expect(page.getByTestId('server-status')).toHaveText('服务端：ok');
  await page.screenshot({
    path: '.work/screenshots/home.png',
    fullPage: true,
    animations: 'disabled',
  });

  for (const name of pages) {
    await nav.getByRole('link', { name }).click();
    await expect(page).toHaveURL(new RegExp(`/${name.toLowerCase()}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    await expect(nav.getByRole('link', { name })).toHaveAttribute('aria-current', 'page');
    await page.screenshot({
      path: `.work/screenshots/${name.toLowerCase()}.png`,
      animations: 'disabled',
    });
  }
});
