import { expect, test } from '@playwright/test';

// 空的数据目录（environment 项目每次删除重建）中没有已评分的 run：Compare 页面显示空状态
test('没有已评分的 run 时提示先在 Runs 页面发起 batch', async ({ page, request }) => {
  const runs = (await (await request.get('/api/compare/runs')).json()) as unknown[];
  expect(runs).toEqual([]);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/compare');
  await expect(page.getByTestId('compare-empty')).toHaveText(
    '还没有已评分的 run。先在 Runs 页面发起一个 batch，运行并评分完成后就能在这里对比。',
  );
  await page.screenshot({ path: '.work/screenshots/w11-empty.png', animations: 'disabled' });
  await page.getByRole('link', { name: '去 Runs 页面' }).click();
  await expect(page).toHaveURL(/\/runs$/);
});
