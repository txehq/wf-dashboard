import { rmSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
  CALC_TICKET,
  CALC_TICKET_URL,
  type CalcRepo,
  createCalcStartRepo,
} from '../server/test/helpers/calc-repo.js';

const shot = (page: Page, name: string) =>
  page.screenshot({
    path: `.work/screenshots/w29-${name}.png`,
    fullPage: true,
    animations: 'disabled',
  });

// 真实 Linear 与 GitHub。工单为 `/lfg 做一个计算器` 建出的 TXE-3777（只读取）；起始仓库由测试新建
// txehq/wfe-test-calc-<时间戳>（一行 README，再加 ci、self-hosted-echo、scheduled-echo），不删除。
// 保存的 task 写进 tasks/，结束时删除
const taskId = `e2e-import-${String(Date.now())}`;
let calc: CalcRepo;

test.beforeAll(async () => {
  test.setTimeout(5 * 60_000);
  calc = await createCalcStartRepo();
});

test.afterAll(() => {
  rmSync(path.join('tasks', taskId), { recursive: true, force: true });
});

test('粘贴工单地址导入：预览完整正文、验收标准、仓库与 commit、checks；修改后保存并生成 bundle', async ({
  page,
}) => {
  test.setTimeout(8 * 60_000);
  await page.goto('/tasks/new');
  await page.getByRole('radio', { name: '/ic 从 Linear 导入' }).click();
  const panel = page.getByTestId('linear-import');
  await panel.getByLabel('工单地址或编号').fill(CALC_TICKET_URL);
  // 工单没有关联 PR：仓库由用户填写，commit 默认取默认分支的最新 commit
  await panel.getByLabel('GitHub 仓库（owner/name）').fill(calc.repo);
  await shot(page, 'paste-address');
  await panel.getByRole('button', { name: '读取工单' }).click();

  const preview = page.getByTestId('import-preview');
  await expect(preview).toBeVisible({ timeout: 240_000 });
  await expect(preview).toContainText(CALC_TICKET);
  await expect(preview).toContainText('P1 单文件页面外壳');
  // 正文完整渲染
  await expect(preview.getByTestId('artifact-markdown')).toContainText('vite-plugin-singlefile');
  // 正文的 ## Acceptance criteria 一节有 8 条：每条带正文原文，显示这次调用的花费
  const criteria = preview.getByTestId('import-criteria').getByRole('listitem');
  await expect(criteria).toHaveCount(8);
  await expect(criteria.first()).toContainText('正文原文：');
  await expect(preview.getByTestId('criteria-cost')).toContainText(/token · \$\d/);
  const repo = preview.getByTestId('import-repo');
  await expect(repo).toContainText(calc.repo);
  await expect(repo).toContainText(calc.workflowsCommit.slice(0, 12));
  await expect(repo).toContainText('工单没有关联已合并的 PR，取默认分支 main 的最新 commit');
  // requiredChecks 默认值：ci（GitHub 托管）与 self-hosted-echo（arc-linux-dind 在 copyRunnerLabels 中）
  const checks = preview.getByTestId('workflow-checks');
  await expect(checks.getByText('ci', { exact: true })).toBeVisible();
  await expect(checks.getByText('self-hosted-echo', { exact: true })).toBeVisible();
  await checks.getByText(/其他不计入终点的 job/).click();
  await expect(checks.getByTestId('jobs-not-counted')).toContainText('scheduled-echo');
  await expect(checks.getByTestId('jobs-not-counted')).toContainText('不由 PR 触发');
  await shot(page, 'import-preview');

  await panel.getByRole('button', { name: '使用这些内容' }).click();
  await expect(page.getByLabel('工单正文')).toHaveValue(/vite-plugin-singlefile/);
  await page.getByLabel('ID').fill(taskId);
  // 验收标准可以增删改：改写第 1 条，再加一条
  await expect(page.getByRole('textbox', { name: /^验收标准第 \d+ 条$/ })).toHaveCount(8);
  await page
    .getByRole('textbox', { name: '验收标准第 1 条' })
    .fill('`npm ci && npm run build` 在干净的检出上生成且只生成 `dist/计算器.html`');
  await page.getByRole('button', { name: '添加', exact: true }).click();
  await page.getByRole('textbox', { name: '验收标准第 9 条' }).fill('README 写明本地开发步骤');
  const source = page.getByTestId('source-repo');
  await expect(source).toContainText(CALC_TICKET);
  await expect(source.getByLabel('GitHub 仓库')).toHaveValue(calc.repo);
  const required = page.getByTestId('required-checks');
  await expect(required.getByRole('textbox')).toHaveCount(2);
  await expect(required.getByRole('textbox').nth(0)).toHaveValue('ci');
  await expect(required.getByRole('textbox').nth(1)).toHaveValue('self-hosted-echo');
  await expect(page.getByLabel('有隐藏测试')).not.toBeChecked();
  await source.scrollIntoViewIfNeeded();
  await shot(page, 'repo-checks');

  await page.getByRole('button', { name: '创建' }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${taskId}$`), { timeout: 180_000 });
  await expect(page.getByLabel('工单正文')).toHaveValue(/vite-plugin-singlefile/);
  const response = await page.request.get(`/api/tasks/${taskId}`);
  const record = (await response.json()) as {
    task: { source: unknown; requiredChecks: string[]; repo: { commit: string } };
  };
  expect(record.task.source).toEqual({
    linear: {
      identifier: CALC_TICKET,
      url: expect.stringContaining(`https://linear.app/capso/issue/${CALC_TICKET}`) as unknown,
    },
    github: { repo: calc.repo },
  });
  expect(record.task.requiredChecks).toEqual(['ci', 'self-hosted-echo']);
  expect(record.task.repo.commit).toBe(calc.workflowsCommit);

  await page.goto('/tasks');
  await expect(page.getByRole('row', { name: new RegExp(taskId) })).toContainText('9 条验收标准');
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
