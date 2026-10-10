import { expect, test, type Page } from '@playwright/test';

const result = (page: Page) => page.getByLabel('结果');
const value = (page: Page) => page.getByLabel('数值');

async function choose(page: Page, category: string, from: string, to: string) {
  await page.getByLabel('类别').selectOption({ label: category });
  await page.getByLabel('从').selectOption({ label: from });
  await page.getByLabel('换算为').selectOption({ label: to });
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
});

test.describe('existing conversions', () => {
  test('one metre is 100 cm on load', async ({ page }) => {
    await expect(result(page)).toHaveText('100 cm');
  });

  test('switching to weight lists weight units', async ({ page }) => {
    await page.getByLabel('类别').selectOption({ label: '重量' });
    await expect(page.getByLabel('从')).toHaveValue('g');
    await expect(page.getByLabel('换算为')).toHaveValue('kg');
    await expect(result(page)).toHaveText('0.001 kg');
  });

  test('surrounding spaces in the value are ignored', async ({ page }) => {
    await value(page).fill('  12  ');
    await expect(result(page)).toHaveText('1200 cm');
  });
});

test.describe('result precision', () => {
  test('1 in shows 2.54 cm', async ({ page }) => {
    await choose(page, '长度', '英寸 (in)', '厘米 (cm)');
    await expect(result(page)).toHaveText('2.54 cm');
  });

  test('3 ft shows 0.9144 m', async ({ page }) => {
    await choose(page, '长度', '英尺 (ft)', '米 (m)');
    await value(page).fill('3');
    await expect(result(page)).toHaveText('0.9144 m');
  });

  test('1 oz is rounded to four decimals', async ({ page }) => {
    await choose(page, '重量', '盎司 (oz)', '克 (g)');
    await expect(result(page)).toHaveText('28.3495 g');
  });

  test('1 mi keeps all three decimals', async ({ page }) => {
    await choose(page, '长度', '英里 (mi)', '米 (m)');
    await expect(result(page)).toHaveText('1609.344 m');
  });
});

test.describe('temperature', () => {
  test('the category lists Celsius, Fahrenheit and Kelvin', async ({ page }) => {
    await page.getByLabel('类别').selectOption({ label: '温度' });
    await expect(page.getByLabel('从').locator('option')).toHaveText([
      '摄氏度 (°C)',
      '华氏度 (°F)',
      '开尔文 (K)',
    ]);
    await expect(page.getByLabel('从')).toHaveValue('c');
    await expect(page.getByLabel('换算为')).toHaveValue('f');
  });

  test('100 °C is 212 °F', async ({ page }) => {
    await page.getByLabel('类别').selectOption({ label: '温度' });
    await value(page).fill('100');
    await expect(result(page)).toHaveText('212 °F');
  });

  test('37 °C is 98.6 °F', async ({ page }) => {
    await choose(page, '温度', '摄氏度 (°C)', '华氏度 (°F)');
    await value(page).fill('37');
    await expect(result(page)).toHaveText('98.6 °F');
  });

  test('-40 °C is -40 °F', async ({ page }) => {
    await choose(page, '温度', '摄氏度 (°C)', '华氏度 (°F)');
    await value(page).fill('-40');
    await expect(result(page)).toHaveText('-40 °F');
  });

  test('0 K is -273.15 °C', async ({ page }) => {
    await choose(page, '温度', '开尔文 (K)', '摄氏度 (°C)');
    await value(page).fill('0');
    await expect(result(page)).toHaveText('-273.15 °C');
  });

  test('1 °F is -17.2222 °C', async ({ page }) => {
    await choose(page, '温度', '华氏度 (°F)', '摄氏度 (°C)');
    await value(page).fill('1');
    await expect(result(page)).toHaveText('-17.2222 °C');
  });

  test('0 °C is 273.15 K', async ({ page }) => {
    await choose(page, '温度', '摄氏度 (°C)', '开尔文 (K)');
    await value(page).fill('0');
    await expect(result(page)).toHaveText('273.15 K');
  });

  test('negative temperatures above absolute zero are allowed', async ({ page }) => {
    await choose(page, '温度', '摄氏度 (°C)', '华氏度 (°F)');
    await value(page).fill('-10');
    await expect(result(page)).toHaveText('14 °F');
    await expect(page.getByText('温度不能低于绝对零度')).toHaveCount(0);
  });

  test('-459.67 °F is exactly absolute zero and allowed', async ({ page }) => {
    await choose(page, '温度', '华氏度 (°F)', '摄氏度 (°C)');
    await value(page).fill('-459.67');
    await expect(result(page)).toHaveText('-273.15 °C');
  });
});

test.describe('invalid input', () => {
  test('empty value shows a dash without an error', async ({ page }) => {
    await value(page).fill('');
    await expect(result(page)).toHaveText('—');
    await expect(page.getByText('请输入数字')).toHaveCount(0);
    await expect(value(page)).not.toHaveAttribute('aria-invalid', 'true');
  });

  for (const text of ['abc', '12abc', '1.2.3', '-']) {
    test(`"${text}" asks for a number`, async ({ page }) => {
      await value(page).fill(text);
      await expect(page.getByText('请输入数字')).toBeVisible();
      await expect(result(page)).toHaveText('—');
      await expect(value(page)).toHaveAttribute('aria-invalid', 'true');
    });
  }

  test('fixing the value clears the error', async ({ page }) => {
    await value(page).fill('abc');
    await expect(page.getByText('请输入数字')).toBeVisible();
    await value(page).fill('2');
    await expect(page.getByText('请输入数字')).toHaveCount(0);
    await expect(value(page)).not.toHaveAttribute('aria-invalid', 'true');
    await expect(result(page)).toHaveText('200 cm');
  });

  test('negative length is rejected', async ({ page }) => {
    await value(page).fill('-5');
    await expect(page.getByText('长度和重量不能为负数')).toBeVisible();
    await expect(result(page)).toHaveText('—');
    await expect(value(page)).toHaveAttribute('aria-invalid', 'true');
  });

  test('negative weight is rejected', async ({ page }) => {
    await page.getByLabel('类别').selectOption({ label: '重量' });
    await value(page).fill('-0.5');
    await expect(page.getByText('长度和重量不能为负数')).toBeVisible();
    await expect(result(page)).toHaveText('—');
  });

  test('-300 °C is below absolute zero', async ({ page }) => {
    await choose(page, '温度', '摄氏度 (°C)', '华氏度 (°F)');
    await value(page).fill('-300');
    await expect(page.getByText('温度不能低于绝对零度')).toBeVisible();
    await expect(result(page)).toHaveText('—');
    await expect(value(page)).toHaveAttribute('aria-invalid', 'true');
  });

  test('-1 K is below absolute zero', async ({ page }) => {
    await choose(page, '温度', '开尔文 (K)', '摄氏度 (°C)');
    await value(page).fill('-1');
    await expect(page.getByText('温度不能低于绝对零度')).toBeVisible();
    await expect(result(page)).toHaveText('—');
  });

  test('-460 °F is below absolute zero', async ({ page }) => {
    await choose(page, '温度', '华氏度 (°F)', '摄氏度 (°C)');
    await value(page).fill('-460');
    await expect(page.getByText('温度不能低于绝对零度')).toBeVisible();
  });

  test('changing the source unit re-checks absolute zero', async ({ page }) => {
    await choose(page, '温度', '摄氏度 (°C)', '开尔文 (K)');
    await value(page).fill('-300');
    await expect(page.getByText('温度不能低于绝对零度')).toBeVisible();
    await page.getByLabel('从').selectOption({ label: '华氏度 (°F)' });
    await expect(page.getByText('温度不能低于绝对零度')).toHaveCount(0);
    await expect(result(page)).toHaveText('88.7056 K');
  });
});

test.describe('swap units', () => {
  test('swapping metre and centimetre', async ({ page }) => {
    await page.getByRole('button', { name: '交换单位' }).click();
    await expect(page.getByLabel('从')).toHaveValue('cm');
    await expect(page.getByLabel('换算为')).toHaveValue('m');
    await expect(result(page)).toHaveText('0.01 m');
  });

  test('swapping temperature units', async ({ page }) => {
    await page.getByLabel('类别').selectOption({ label: '温度' });
    await value(page).fill('212');
    await page.getByRole('button', { name: '交换单位' }).click();
    await expect(page.getByLabel('从')).toHaveValue('f');
    await expect(page.getByLabel('换算为')).toHaveValue('c');
    await expect(result(page)).toHaveText('100 °C');
  });

  test('swapping twice restores the original direction', async ({ page }) => {
    const swap = page.getByRole('button', { name: '交换单位' });
    await swap.click();
    await swap.click();
    await expect(page.getByLabel('从')).toHaveValue('m');
    await expect(result(page)).toHaveText('100 cm');
  });

  test('swapping keeps the value and does not submit the page', async ({ page }) => {
    await value(page).fill('250');
    await page.getByRole('button', { name: '交换单位' }).click();
    await expect(value(page)).toHaveValue('250');
    await expect(result(page)).toHaveText('2.5 m');
  });
});
