import { rmSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';

const shot = (page: Page, name: string) =>
  page.screenshot({
    path: `.work/screenshots/w28-${name}.png`,
    fullPage: true,
    animations: 'disabled',
  });

// 真实 Linear 与 GitHub，只读取。保存的 task 写进 tasks/，结束时删除
const taskId = `e2e-import-${String(Date.now())}`;
const ADDRESS =
  'https://linear.app/capso/issue/TXE-3635/cc3-sfdcda9-validator-site-browser-drops-the-release-label-because-it';

test.afterAll(() => {
  rmSync(path.join('tasks', taskId), { recursive: true, force: true });
});

test('粘贴工单地址导入：预览完整正文、仓库与 commit、checks；补上验收标准后保存并生成 bundle', async ({
  page,
}) => {
  test.setTimeout(5 * 60_000);
  await page.goto('/tasks/new');
  await page.getByRole('radio', { name: '/ic 从 Linear 导入' }).click();
  const panel = page.getByTestId('linear-import');
  await panel.getByLabel('工单地址或编号').fill(ADDRESS);
  await shot(page, 'paste-address');
  await panel.getByRole('button', { name: '读取工单' }).click();

  const preview = page.getByTestId('import-preview');
  await expect(preview).toBeVisible({ timeout: 120_000 });
  await expect(preview).toContainText('TXE-3635');
  await expect(preview).toContainText('Validator Site browser drops the release label');
  // 正文完整渲染（含正文中的代码与说明）
  await expect(preview.getByTestId('artifact-markdown')).toContainText('validator-site-web@0.1.1');
  await expect(preview.getByTestId('no-criteria')).toBeVisible();
  const repo = preview.getByTestId('import-repo');
  await expect(repo).toContainText('txehq/tokun-cn');
  await expect(repo).toContainText('f8df1eae3559');
  await expect(repo).toContainText('工单关联的 PR #638（已合并）的 base commit');
  const checks = preview.getByTestId('workflow-checks');
  await expect(checks).toContainText('没有。终点只要求 PR 不是草稿。');
  await expect(checks.getByTestId('jobs-cannot-run-summary')).toContainText(
    '56 个 job：自托管 runner arc-linux-dind',
  );
  await expect(checks.getByTestId('jobs-cannot-run')).toContainText('validator-site-ci.yml');
  await shot(page, 'import-preview');

  await panel.getByRole('button', { name: '使用这些内容' }).click();
  await expect(page.getByLabel('工单正文')).toHaveValue(/validator-site-web@0\.1\.1/);
  await page.getByLabel('ID').fill(taskId);
  // 正文没有验收标准一节：在表单中补上
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page
    .getByRole('textbox', { name: '验收标准第 1 条' })
    .fill('analytics 接受部署的 web-config 实际给出的 release 值 validator-site-web@0.1.1-capso.184（允许 @ 与 +）');
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page
    .getByRole('textbox', { name: '验收标准第 2 条' })
    .fill('单元测试用这个真实的 release 值覆盖修复，npm test 通过');
  const source = page.getByTestId('source-repo');
  await expect(source).toContainText('TXE-3635');
  await expect(source.getByLabel('GitHub 仓库')).toHaveValue('txehq/tokun-cn');
  await expect(source.getByTestId('jobs-cannot-run-summary')).toContainText('arc-linux-dind');
  await expect(page.getByTestId('required-checks')).toContainText('没有。终点只要求 PR 不是草稿。');
  await expect(page.getByLabel('有隐藏测试')).not.toBeChecked();
  await source.scrollIntoViewIfNeeded();
  await shot(page, 'repo-checks');

  await page.getByRole('button', { name: '创建' }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`), { timeout: 180_000 });
  await expect(page.getByLabel('工单正文')).toHaveValue(/validator-site-web@0\.1\.1/);
  await expect(page.getByTestId('source-repo')).toContainText('TXE-3635');
  const response = await page.request.get(`/api/tasks/${taskId}`);
  const record = (await response.json()) as {
    task: { source: unknown; requiredChecks: string[]; repo: { commit: string } };
  };
  expect(record.task.source).toEqual({
    linear: {
      identifier: 'TXE-3635',
      url: expect.stringContaining('https://linear.app/capso/issue/TXE-3635') as unknown,
    },
    github: { repo: 'txehq/tokun-cn' },
  });
  expect(record.task.requiredChecks).toEqual([]);
  expect(record.task.repo.commit).toBe('f8df1eae355960da774e3e08f4f6a248f05b0910');

  await page.goto('/tasks');
  await expect(page.locator('[data-slot=card]', { hasText: '/ic' })).toContainText('2 条验收标准');
});

test('地址不是 Linear 工单时显示原文错误', async ({ page }) => {
  await page.goto('/tasks/new');
  await page.getByRole('radio', { name: '/ic 从 Linear 导入' }).click();
  const panel = page.getByTestId('linear-import');
  await panel.getByLabel('工单地址或编号').fill('https://linear.app/capso/project/okr');
  await panel.getByRole('button', { name: '读取工单' }).click();
  await expect(panel.getByRole('alert')).toContainText(
    '不是 Linear 工单地址或工单编号：https://linear.app/capso/project/okr',
  );
});
