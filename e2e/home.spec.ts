import { expect, test } from '@playwright/test';
import { serverPort } from '../ports.js';

const pages = [
  { name: 'Sessions', path: 'sessions' },
  { name: 'Workflows', path: 'workflows' },
  { name: 'Live', path: 'live' },
  { name: 'Tasks', path: 'tasks' },
  { name: 'Runs', path: 'runs' },
  { name: 'Compare', path: 'compare' },
  { name: 'Analyses', path: 'analyses' },
];

test('服务端健康检查返回 ok', async ({ request }) => {
  const response = await request.get(`http://127.0.0.1:${String(serverPort)}/api/health`);
  expect(response.ok()).toBe(true);
  expect(await response.json()).toEqual({ status: 'ok' });
});

test('首页显示导航页面并经代理连上服务端；每个页面的标题与浏览器标签页标题', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/sessions$/);

  const nav = page.getByRole('navigation', { name: '主导航' });
  await expect(nav.getByRole('link')).toHaveText(pages.map((p) => p.name));
  await expect(page.getByTestId('server-status')).toHaveText('服务端：ok');
  await page.screenshot({
    path: '.work/screenshots/home.png',
    fullPage: true,
    animations: 'disabled',
  });

  for (const { name, path } of pages) {
    await nav.getByRole('link', { name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/${path}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
    await expect(page).toHaveTitle(`${name} · Magi Workflow Dashboard`);
    await expect(nav.getByRole('link', { name, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await page.screenshot({
      path: `.work/screenshots/${path}.png`,
      animations: 'disabled',
    });
  }
  await page.goto('/analyses/new');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('New analysis');
  await expect(page).toHaveTitle('New analysis · Magi Workflow Dashboard');
});
