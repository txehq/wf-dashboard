import fs from 'node:fs';
import path from 'node:path';
import { expect, type Request, test } from '@playwright/test';
import { runsServerPort } from '../ports.js';

// 数据目录与 runs.spec.ts 相同（prepare-runs-e2e 导入 W4 的 run 并补齐导入的 variant 的内容）。
// 文件缺失的情形是真实的：把这个 variant 的 src/skills 移走，测试结束后移回
const api = `http://127.0.0.1:${String(runsServerPort)}/api`;
const dataDir = path.resolve(import.meta.dirname, '../.work/e2e/runs-data');
const runId = 'r-20261009-dqva52';
const shots = '.work/screenshots';

let skillsDir = '';
const moved = () => `${skillsDir}.moved`;

test.afterAll(() => {
  if (fs.existsSync(moved())) fs.renameSync(moved(), skillsDir);
});

test('导入的 variant：只读标记、文件与对比；文件缺失时显示错误且不再重复请求', async ({
  page,
  request,
}) => {
  const run = (await (await request.get(`${api}/runs/${runId}`)).json()) as { variantId: string };
  skillsDir = path.join(dataDir, 'variants', run.variantId, 'src/skills');

  await page.goto('/variants');
  const row = page.getByRole('row').filter({ has: page.locator(`a[href$="${run.variantId}"]`) });
  await expect(row).toContainText('导入的 variant（只读，不可构建与运行）');
  await row.getByRole('link').click();

  await expect(page.getByTestId('build-status')).toHaveText(
    '导入的 variant（只读，不可构建与运行）',
  );
  await expect(page.getByRole('button', { name: '构建并安装' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '另存为新 variant' })).toHaveCount(0);
  const tree = page.getByRole('navigation', { name: 'skills 文件' });
  await expect(tree.getByRole('button', { name: 'lfg', exact: true })).toBeVisible();
  await expect(page.getByTestId('skill-editor').locator('.view-lines')).toContainText('name: lfg');
  await expect(page.getByRole('button', { name: '保存' })).toHaveCount(0);
  await page.getByRole('tab', { name: '对比' }).click();
  await expect(page.getByText('skills 内容相同，没有差异。')).toBeVisible();
  await page.getByRole('tab', { name: '构建日志' }).click();
  await expect(
    page.getByText('导入的 variant（只读，不可构建与运行），没有构建日志。'),
  ).toBeVisible();
  await page.screenshot({ path: `${shots}/w14b-imported.png`, animations: 'disabled' });

  // 移走 skills：files 返回 500，页面显示服务端的错误原文
  fs.renameSync(skillsDir, moved());
  const filesRequests: Request[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith(`/api/variants/${run.variantId}/files`)) filesRequests.push(r);
  });
  await page.reload();
  const error = page.getByTestId('query-error');
  await expect(error).toContainText(`ENOENT: no such file or directory, scandir '${skillsDir}'`);
  await page.screenshot({ path: `${shots}/w14b-error.png`, animations: 'disabled' });
  const afterError = filesRequests.length;
  expect(afterError).toBe(1);
  // TanStack Query 默认会在 1、2、4 秒后重试；窗口重新获得焦点也不重新请求
  await page.waitForTimeout(8_000);
  await page.evaluate(
    'window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange"))',
  );
  await page.waitForTimeout(1_000);
  expect(filesRequests.length).toBe(afterError);

  // 「重试」只请求一次；文件仍然缺失时仍显示错误
  await page.getByRole('button', { name: '重试' }).click();
  await expect.poll(() => filesRequests.length).toBe(afterError + 1);
  await expect(error).toContainText('ENOENT');

  // 移回后重试，文件树出现
  fs.renameSync(moved(), skillsDir);
  await page.getByRole('button', { name: '重试' }).click();
  await expect(tree.getByRole('button', { name: 'lfg', exact: true })).toBeVisible();
  await expect(error).toHaveCount(0);
});
