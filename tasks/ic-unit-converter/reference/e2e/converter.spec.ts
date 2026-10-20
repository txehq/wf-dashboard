import { expect, test } from '@playwright/test';

test('converts one metre to centimetres on load', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('结果')).toHaveText('100 cm');
});

test('updates the result while typing', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('从').selectOption({ label: '千米 (km)' });
  await page.getByLabel('换算为').selectOption({ label: '米 (m)' });
  await page.getByLabel('数值').fill('3');
  await expect(page.getByLabel('结果')).toHaveText('3000 m');
});

test('switching category lists that category’s units', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('类别').selectOption({ label: '重量' });
  await expect(page.getByLabel('从')).toHaveValue('g');
  await expect(page.getByLabel('换算为')).toHaveValue('kg');
  await expect(page.getByLabel('结果')).toHaveText('0.001 kg');
});

test('shows results rounded to four decimals', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('从').selectOption({ label: '英寸 (in)' });
  await expect(page.getByLabel('结果')).toHaveText('2.54 cm');
});

test('converts temperatures', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('类别').selectOption({ label: '温度' });
  await page.getByLabel('数值').fill('100');
  await expect(page.getByLabel('结果')).toHaveText('212 °F');
});

test('explains invalid values', async ({ page }) => {
  await page.goto('/');
  const value = page.getByLabel('数值');
  await value.fill('12abc');
  await expect(page.getByRole('alert')).toHaveText('请输入数字');
  await expect(value).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('结果')).toHaveText('—');
  await value.fill('-5');
  await expect(page.getByRole('alert')).toHaveText('长度和重量不能为负数');
  await value.fill('');
  await expect(page.getByRole('alert')).toBeHidden();
  await expect(page.getByLabel('结果')).toHaveText('—');
});

test('swaps the units', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '交换单位' }).click();
  await expect(page.getByLabel('从')).toHaveValue('cm');
  await expect(page.getByLabel('结果')).toHaveText('0.01 m');
});
