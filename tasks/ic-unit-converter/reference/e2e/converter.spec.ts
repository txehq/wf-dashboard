import { expect, test } from '@playwright/test';

test('converts one metre to centimetres on load', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByLabel('Result')).toHaveText('100 cm');
});

test('updates the result while typing', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('From').selectOption({ label: 'Kilometre (km)' });
  await page.getByLabel('To').selectOption({ label: 'Metre (m)' });
  await page.getByLabel('Value').fill('3');
  await expect(page.getByLabel('Result')).toHaveText('3000 m');
});

test('switching category lists that category’s units', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Category').selectOption({ label: 'Weight' });
  await expect(page.getByLabel('From')).toHaveValue('g');
  await expect(page.getByLabel('To')).toHaveValue('kg');
  await expect(page.getByLabel('Result')).toHaveText('0.001 kg');
});

test('shows results rounded to four decimals', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('From').selectOption({ label: 'Inch (in)' });
  await expect(page.getByLabel('Result')).toHaveText('2.54 cm');
});

test('converts temperatures', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Category').selectOption({ label: 'Temperature' });
  await page.getByLabel('Value').fill('100');
  await expect(page.getByLabel('Result')).toHaveText('212 °F');
});

test('explains invalid values', async ({ page }) => {
  await page.goto('/');
  const value = page.getByLabel('Value');
  await value.fill('12abc');
  await expect(page.getByRole('alert')).toHaveText('Enter a number');
  await expect(value).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByLabel('Result')).toHaveText('—');
  await value.fill('-5');
  await expect(page.getByRole('alert')).toHaveText('Length and weight cannot be negative');
  await value.fill('');
  await expect(page.getByRole('alert')).toBeHidden();
  await expect(page.getByLabel('Result')).toHaveText('—');
});

test('swaps the units', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Swap units' }).click();
  await expect(page.getByLabel('From')).toHaveValue('cm');
  await expect(page.getByLabel('Result')).toHaveText('0.01 m');
});
