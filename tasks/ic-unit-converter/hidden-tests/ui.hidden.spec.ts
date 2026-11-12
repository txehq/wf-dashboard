import { expect, test, type Page } from '@playwright/test';

const result = (page: Page) => page.getByLabel('Result');
const value = (page: Page) => page.getByLabel('Value');

async function choose(page: Page, category: string, from: string, to: string) {
  await page.getByLabel('Category').selectOption({ label: category });
  await page.getByLabel('From').selectOption({ label: from });
  await page.getByLabel('To').selectOption({ label: to });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('existing conversions', () => {
  test('one metre is 100 cm on load', async ({ page }) => {
    await expect(result(page)).toHaveText('100 cm');
  });

  test('switching to weight lists weight units', async ({ page }) => {
    await page.getByLabel('Category').selectOption({ label: 'Weight' });
    await expect(page.getByLabel('From')).toHaveValue('g');
    await expect(page.getByLabel('To')).toHaveValue('kg');
    await expect(result(page)).toHaveText('0.001 kg');
  });

  test('surrounding spaces in the value are ignored', async ({ page }) => {
    await value(page).fill('  12  ');
    await expect(result(page)).toHaveText('1200 cm');
  });
});

test.describe('result precision', () => {
  test('1 in shows 2.54 cm', async ({ page }) => {
    await choose(page, 'Length', 'Inch (in)', 'Centimetre (cm)');
    await expect(result(page)).toHaveText('2.54 cm');
  });

  test('3 ft shows 0.9144 m', async ({ page }) => {
    await choose(page, 'Length', 'Foot (ft)', 'Metre (m)');
    await value(page).fill('3');
    await expect(result(page)).toHaveText('0.9144 m');
  });

  test('1 oz is rounded to four decimals', async ({ page }) => {
    await choose(page, 'Weight', 'Ounce (oz)', 'Gram (g)');
    await expect(result(page)).toHaveText('28.3495 g');
  });

  test('1 mi keeps all three decimals', async ({ page }) => {
    await choose(page, 'Length', 'Mile (mi)', 'Metre (m)');
    await expect(result(page)).toHaveText('1609.344 m');
  });
});

test.describe('temperature', () => {
  test('the category lists Celsius, Fahrenheit and Kelvin', async ({ page }) => {
    await page.getByLabel('Category').selectOption({ label: 'Temperature' });
    await expect(page.getByLabel('From').locator('option')).toHaveText([
      'Celsius (°C)',
      'Fahrenheit (°F)',
      'Kelvin (K)',
    ]);
    await expect(page.getByLabel('From')).toHaveValue('c');
    await expect(page.getByLabel('To')).toHaveValue('f');
  });

  test('100 °C is 212 °F', async ({ page }) => {
    await page.getByLabel('Category').selectOption({ label: 'Temperature' });
    await value(page).fill('100');
    await expect(result(page)).toHaveText('212 °F');
  });

  test('37 °C is 98.6 °F', async ({ page }) => {
    await choose(page, 'Temperature', 'Celsius (°C)', 'Fahrenheit (°F)');
    await value(page).fill('37');
    await expect(result(page)).toHaveText('98.6 °F');
  });

  test('-40 °C is -40 °F', async ({ page }) => {
    await choose(page, 'Temperature', 'Celsius (°C)', 'Fahrenheit (°F)');
    await value(page).fill('-40');
    await expect(result(page)).toHaveText('-40 °F');
  });

  test('0 K is -273.15 °C', async ({ page }) => {
    await choose(page, 'Temperature', 'Kelvin (K)', 'Celsius (°C)');
    await value(page).fill('0');
    await expect(result(page)).toHaveText('-273.15 °C');
  });

  test('1 °F is -17.2222 °C', async ({ page }) => {
    await choose(page, 'Temperature', 'Fahrenheit (°F)', 'Celsius (°C)');
    await value(page).fill('1');
    await expect(result(page)).toHaveText('-17.2222 °C');
  });

  test('0 °C is 273.15 K', async ({ page }) => {
    await choose(page, 'Temperature', 'Celsius (°C)', 'Kelvin (K)');
    await value(page).fill('0');
    await expect(result(page)).toHaveText('273.15 K');
  });

  test('negative temperatures above absolute zero are allowed', async ({ page }) => {
    await choose(page, 'Temperature', 'Celsius (°C)', 'Fahrenheit (°F)');
    await value(page).fill('-10');
    await expect(result(page)).toHaveText('14 °F');
    await expect(page.getByText('Temperature cannot be below absolute zero')).toHaveCount(0);
  });

  test('-459.67 °F is exactly absolute zero and allowed', async ({ page }) => {
    await choose(page, 'Temperature', 'Fahrenheit (°F)', 'Celsius (°C)');
    await value(page).fill('-459.67');
    await expect(result(page)).toHaveText('-273.15 °C');
  });
});

test.describe('invalid input', () => {
  test('empty value shows a dash without an error', async ({ page }) => {
    await value(page).fill('');
    await expect(result(page)).toHaveText('—');
    await expect(page.getByText('Enter a number')).toHaveCount(0);
    await expect(value(page)).not.toHaveAttribute('aria-invalid', 'true');
  });

  for (const text of ['abc', '12abc', '1.2.3', '-']) {
    test(`"${text}" asks for a number`, async ({ page }) => {
      await value(page).fill(text);
      await expect(page.getByText('Enter a number')).toBeVisible();
      await expect(result(page)).toHaveText('—');
      await expect(value(page)).toHaveAttribute('aria-invalid', 'true');
    });
  }

  test('fixing the value clears the error', async ({ page }) => {
    await value(page).fill('abc');
    await expect(page.getByText('Enter a number')).toBeVisible();
    await value(page).fill('2');
    await expect(page.getByText('Enter a number')).toHaveCount(0);
    await expect(value(page)).not.toHaveAttribute('aria-invalid', 'true');
    await expect(result(page)).toHaveText('200 cm');
  });

  test('negative length is rejected', async ({ page }) => {
    await value(page).fill('-5');
    await expect(page.getByText('Length and weight cannot be negative')).toBeVisible();
    await expect(result(page)).toHaveText('—');
    await expect(value(page)).toHaveAttribute('aria-invalid', 'true');
  });

  test('negative weight is rejected', async ({ page }) => {
    await page.getByLabel('Category').selectOption({ label: 'Weight' });
    await value(page).fill('-0.5');
    await expect(page.getByText('Length and weight cannot be negative')).toBeVisible();
    await expect(result(page)).toHaveText('—');
  });

  test('-300 °C is below absolute zero', async ({ page }) => {
    await choose(page, 'Temperature', 'Celsius (°C)', 'Fahrenheit (°F)');
    await value(page).fill('-300');
    await expect(page.getByText('Temperature cannot be below absolute zero')).toBeVisible();
    await expect(result(page)).toHaveText('—');
    await expect(value(page)).toHaveAttribute('aria-invalid', 'true');
  });

  test('-1 K is below absolute zero', async ({ page }) => {
    await choose(page, 'Temperature', 'Kelvin (K)', 'Celsius (°C)');
    await value(page).fill('-1');
    await expect(page.getByText('Temperature cannot be below absolute zero')).toBeVisible();
    await expect(result(page)).toHaveText('—');
  });

  test('-460 °F is below absolute zero', async ({ page }) => {
    await choose(page, 'Temperature', 'Fahrenheit (°F)', 'Celsius (°C)');
    await value(page).fill('-460');
    await expect(page.getByText('Temperature cannot be below absolute zero')).toBeVisible();
  });

  test('changing the source unit re-checks absolute zero', async ({ page }) => {
    await choose(page, 'Temperature', 'Celsius (°C)', 'Kelvin (K)');
    await value(page).fill('-300');
    await expect(page.getByText('Temperature cannot be below absolute zero')).toBeVisible();
    await page.getByLabel('From').selectOption({ label: 'Fahrenheit (°F)' });
    await expect(page.getByText('Temperature cannot be below absolute zero')).toHaveCount(0);
    await expect(result(page)).toHaveText('88.7056 K');
  });
});

test.describe('swap units', () => {
  test('swapping metre and centimetre', async ({ page }) => {
    await page.getByRole('button', { name: 'Swap units' }).click();
    await expect(page.getByLabel('From')).toHaveValue('cm');
    await expect(page.getByLabel('To')).toHaveValue('m');
    await expect(result(page)).toHaveText('0.01 m');
  });

  test('swapping temperature units', async ({ page }) => {
    await page.getByLabel('Category').selectOption({ label: 'Temperature' });
    await value(page).fill('212');
    await page.getByRole('button', { name: 'Swap units' }).click();
    await expect(page.getByLabel('From')).toHaveValue('f');
    await expect(page.getByLabel('To')).toHaveValue('c');
    await expect(result(page)).toHaveText('100 °C');
  });

  test('swapping twice restores the original direction', async ({ page }) => {
    const swap = page.getByRole('button', { name: 'Swap units' });
    await swap.click();
    await swap.click();
    await expect(page.getByLabel('From')).toHaveValue('m');
    await expect(result(page)).toHaveText('100 cm');
  });

  test('swapping keeps the value and does not submit the page', async ({ page }) => {
    await value(page).fill('250');
    await page.getByRole('button', { name: 'Swap units' }).click();
    await expect(value(page)).toHaveValue('250');
    await expect(result(page)).toHaveText('2.5 m');
  });
});
