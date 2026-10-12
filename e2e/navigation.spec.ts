import { expect, type Page, test } from '@playwright/test';

// W35：导航的分组、展开与收起、键盘操作
const shots = '.work/screenshots';

const nav = (page: Page) => page.getByRole('navigation', { name: '主导航' });
const groupButton = (page: Page, name: string) =>
  nav(page).getByRole('button', { name, exact: true });

test('导航的结构与顺序：顶层三项，Evaluate 与 Optimize 两个分组，默认展开', async ({ page }) => {
  await page.goto('/sessions');
  const n = nav(page);
  // 菜单项与分组标题按出现的顺序
  await expect(n.locator('a, button')).toHaveText([
    'Sessions',
    'Variants',
    'Live',
    'Evaluate',
    'Tasks',
    'Runs',
    'Compare',
    'Optimize',
    'Analyses',
  ]);
  await expect(groupButton(page, 'Evaluate')).toHaveAttribute('aria-expanded', 'true');
  await expect(groupButton(page, 'Optimize')).toHaveAttribute('aria-expanded', 'true');
  // 子项缩进：比顶层项更靠右
  const top = await n.getByRole('link', { name: 'Sessions' }).locator('svg').boundingBox();
  const child = await n.getByRole('link', { name: 'Runs' }).locator('svg').boundingBox();
  expect((child?.x ?? 0) - (top?.x ?? 0)).toBeGreaterThan(8);
  await page.screenshot({ path: `${shots}/w35-expanded.png`, animations: 'disabled' });
});

test('收起 Evaluate 后子项隐藏，刷新后保持收起；进入 /runs 时自动展开', async ({ page }) => {
  await page.goto('/sessions');
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.reload();
  const n = nav(page);
  await groupButton(page, 'Evaluate').click();
  await expect(groupButton(page, 'Evaluate')).toHaveAttribute('aria-expanded', 'false');
  for (const name of ['Tasks', 'Runs', 'Compare']) {
    await expect(n.getByRole('link', { name })).toBeHidden();
  }
  await expect(n.getByRole('link', { name: 'Analyses' })).toBeVisible();
  await page.screenshot({ path: `${shots}/w35-evaluate-collapsed.png`, animations: 'disabled' });

  await page.reload();
  await expect(groupButton(page, 'Evaluate')).toHaveAttribute('aria-expanded', 'false');
  await expect(n.getByRole('link', { name: 'Runs' })).toBeHidden();

  // 当前页面在分组中时总是展开，收起的设置保留：离开后又收起
  await page.goto('/runs');
  await expect(groupButton(page, 'Evaluate')).toHaveAttribute('aria-expanded', 'true');
  await expect(n.getByRole('link', { name: 'Runs' })).toHaveAttribute('aria-current', 'page');
  await groupButton(page, 'Evaluate').click();
  await expect(groupButton(page, 'Evaluate')).toHaveAttribute('aria-expanded', 'true');
  await n.getByRole('link', { name: 'Sessions' }).click();
  await expect(groupButton(page, 'Evaluate')).toHaveAttribute('aria-expanded', 'false');

  // 再点一次展开，刷新后保持展开
  await groupButton(page, 'Evaluate').click();
  await page.reload();
  await expect(groupButton(page, 'Evaluate')).toHaveAttribute('aria-expanded', 'true');
});

test('详情页也算在分组中：/analyses/new 时 Optimize 展开，Analyses 为当前项', async ({ page }) => {
  await page.goto('/sessions');
  await groupButton(page, 'Optimize').click();
  await expect(groupButton(page, 'Optimize')).toHaveAttribute('aria-expanded', 'false');
  await page.goto('/analyses/new');
  await expect(groupButton(page, 'Optimize')).toHaveAttribute('aria-expanded', 'true');
  await expect(nav(page).getByRole('link', { name: 'Analyses' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.goto('/analyses');
  await page.screenshot({ path: `${shots}/w35-optimize-current.png`, animations: 'disabled' });
  await page.evaluate(() => {
    localStorage.clear();
  });
});

test('键盘：Tab 到分组标题，Enter 展开，Tab 进入子项，Enter 打开页面', async ({ page }) => {
  await page.goto('/sessions');
  await groupButton(page, 'Evaluate').click();
  await expect(groupButton(page, 'Evaluate')).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('link', { name: 'Sessions' }).focus();
  // Sessions → Variants → Live → Evaluate
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('Tab');
  await expect(groupButton(page, 'Evaluate')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(groupButton(page, 'Evaluate')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Tab');
  await expect(nav(page).getByRole('link', { name: 'Tasks' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(nav(page).getByRole('link', { name: 'Runs' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/runs$/);
  await expect(nav(page).getByRole('link', { name: 'Runs' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await page.evaluate(() => {
    localStorage.clear();
  });
});
