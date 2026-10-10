import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page, test } from '@playwright/test';

// 使用手册各步骤的截图，全部来自真实操作：数据目录中有 W4 端到端导入的真实 run；
// 基线从 txe-workflow 真实导入，派生的 variant 真实编辑与构建，发起一个真实的 lfg run，接管回答后取消
test.describe.configure({ mode: 'serial' });
test.setTimeout(60 * 60_000);

const marker = randomUUID().slice(0, 4);
const baseName = `基线 ${marker}`;
const modName = `research 评审最多两轮 ${marker}`;
const shots = '.work/guide/screenshots';
const sourcePath = path.join(
  os.homedir(),
  '.claude/projects/-Users-linhaoz-Project-txe-txe-workflow',
);
const gradedRun = 'r-20261009-dqva52';

const shot = (target: Page | Locator, name: string) =>
  target.screenshot({
    path: `${shots}/guide-${name}.png`,
    animations: 'disabled',
  });

test('01 环境检查', async ({ page }) => {
  await page.goto('/sessions');
  const status = page.getByTestId('environment-status');
  await expect(status).not.toHaveText('环境检查中…', { timeout: 180_000 });
  await status.click();
  await expect(page.getByTestId('environment-checks').getByRole('listitem')).toHaveCount(12);
  await page.getByTestId('env-check-codex').getByRole('button').click();
  await expect(page.getByTestId('env-check-codex').getByTestId('env-detail')).toBeVisible();
  await shot(page, '01-environment');
});

test('02 离线分析：来源目录、session 列表、阶段图与请求明细', async ({ page, request }) => {
  await page.goto('/sessions');
  const checkbox = page.getByRole('checkbox', { name: sourcePath, exact: true });
  const sources = (await (await request.get('/api/sources')).json()) as {
    path: string;
    checked: boolean;
  }[];
  if (sources.find((s) => s.path === sourcePath)?.checked === true) {
    // 已有勾选时来源列表默认收起
    await page.getByRole('button', { name: /来源目录/ }).click();
  } else {
    await checkbox.check();
    await expect(page.getByTestId('import-result')).toContainText('已导入', { timeout: 300_000 });
  }
  await expect(checkbox).toBeChecked();
  await expect(page.getByTestId('session-row').first()).toBeVisible();
  await shot(page, '02-sessions');

  // 导入的历史 session 在点开后才判定
  await page.getByRole('searchbox', { name: '搜索 session' }).fill('f0aca373');
  const unanalyzed = page.getByTestId('session-row').filter({ hasText: 'f0aca373' });
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  await unanalyzed.getByRole('link').click();
  await expect(page.getByRole('button', { name: '分析阶段' })).toBeVisible();
  await shot(page, '03-session-unanalyzed');

  // dashboard 发起的运行边运行边判定：W4 的 lfg run
  const run = (await (await request.get(`/api/runs/${gradedRun}`)).json()) as { sessionId: string };
  await page.goto(`/sessions/${run.sessionId}`);
  const lfg = page.getByTestId('workflow-lfg');
  await expect(lfg.getByTestId('stage-research')).toHaveAttribute('data-status', 'done');
  await lfg.scrollIntoViewIfNeeded();
  await shot(page, '04-session-stages');
  await lfg.getByTestId('stage-interview').click();
  const detail = page.getByTestId('stage-detail');
  await expect(detail.getByRole('heading', { level: 2 })).toHaveText('/lfg · interview');
  await expect(detail.getByTestId('request-row').first()).toBeVisible();
  await detail.scrollIntoViewIfNeeded();
  await shot(page, '05-session-requests');
});

test('03 建基线 variant、派生并编辑 skill、构建', async ({ page, request }) => {
  page.on('dialog', (dialog) => {
    void dialog.accept(modName);
  });
  await page.goto('/variants');
  await page.getByLabel('名称').fill(baseName);
  await shot(page, '06-variant-import');
  await page.getByRole('button', { name: '导入基线' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(baseName, { timeout: 120_000 });
  const baseUrl = page.url();
  // 基线本身也要构建才能运行
  const baseId = baseUrl.split('/').at(-1) ?? '';
  const built = await request.post(`/api/variants/${baseId}/build`, { timeout: 900_000 });
  expect(((await built.json()) as { buildStatus: string }).buildStatus).toBe('built');

  await page.reload();
  await page.getByRole('button', { name: '另存为新 variant' }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(modName);
  await shot(page, '07-variant-derived');

  // research 的评审最多两轮：在 research/SKILL.md 中加一条规则
  const tree = page.getByRole('navigation', { name: 'skills 文件' });
  await tree.getByRole('button', { name: 'research', exact: true }).click();
  await tree.getByTitle('skills/research/SKILL.md').click();
  const editor = page.getByTestId('skill-editor');
  await expect(editor.locator('.view-lines')).toContainText('name: research');
  await editor.locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(
    '\n\nReview the draft at most twice; after the second review, lock it.\n',
  );
  await expect(page.getByText('未保存')).toBeVisible();
  await shot(page, '08-skill-edit');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('未保存')).toHaveCount(0);

  await page.getByRole('tab', { name: '对比' }).click();
  await expect(page.getByTestId('skill-diff').locator('.line-insert').first()).toBeVisible();
  await shot(page, '09-skill-diff');

  await page.getByRole('button', { name: '构建并安装' }).click();
  await expect(page.getByTestId('build-status')).toHaveText('已构建', { timeout: 840_000 });
  await expect(page.getByTestId('build-log')).toContainText('=== 构建完成');
  await shot(page, '10-build-log');
});

test('04 发起 batch、观察、接管与交还、取消', async ({ page }) => {
  page.on('dialog', (dialog) => {
    void dialog.accept();
  });
  await page.goto('/runs');
  const launch = page.getByTestId('launch-batch');
  await launch.getByRole('checkbox', { name: baseName }).check();
  await launch.getByRole('checkbox', { name: modName }).check();
  await launch.getByRole('checkbox', { name: '课堂用的网页计算器' }).check();
  await launch.getByRole('checkbox', { name: '金额格式化：按币种小数位、负数与大金额' }).check();
  await expect(page.getByTestId('launch-summary')).toContainText(
    '2 个 variant × 2 个 task × 3 次 = 12 个 run',
  );
  await shot(launch, '11-launch');

  // 手册只真实发起其中一个：修改后的 variant × lfg-calculator × 1 次
  await launch.getByRole('checkbox', { name: baseName }).uncheck();
  await launch.getByRole('checkbox', { name: '金额格式化：按币种小数位、负数与大金额' }).uncheck();
  await launch.getByRole('spinbutton').fill('1');
  await launch.getByRole('button', { name: '发起 1 个 run' }).click();
  await expect(page.getByTestId('launch-done')).toBeVisible();
  const batchId = (await page.getByTestId('launch-done').locator('.font-mono').textContent()) ?? '';
  const row = page.locator(`[data-batch="${batchId}"]`).getByTestId('run-row');
  await expect(row.getByTestId('run-status')).toHaveAttribute('data-status', 'running', {
    timeout: 300_000,
  });
  await shot(page, '12-run-list');

  await row.getByRole('link').first().click();
  await expect(page.getByTestId('run-mode')).toHaveText('模拟用户回答中');
  await page.getByRole('button', { name: '接管' }).click();
  await expect(page.getByTestId('run-mode')).toHaveText('人工回答中');
  await expect(page.getByTestId('run-stages').getByTestId('stage-interview')).toHaveAttribute(
    'data-status',
    'active',
    { timeout: 600_000 },
  );
  const reply = page.getByLabel('你的回答');
  const choice = page.getByTestId('question-reply');
  await expect(reply.or(choice)).toBeVisible({ timeout: 900_000 });
  if (await reply.isVisible()) {
    await reply.fill(
      '使用者是初一到初三的学生，在学校机房（Windows 7、Chrome 109）和家里用，我会在投影上演示。机房经常断网，必须完全离线。其他问题请继续问。',
    );
    await shot(page, '13-takeover');
    await page.getByRole('button', { name: '发送回答' }).click();
  } else {
    for (const fieldset of await choice.locator('fieldset').all()) {
      await fieldset.locator('input[type=radio], input[type=checkbox]').first().check();
    }
    await shot(page, '13-takeover');
    await choice.getByRole('button', { name: '提交选择' }).click();
  }
  await expect(page.getByTestId('message-human')).toHaveCount(1);
  await page.getByRole('button', { name: '交还模拟用户' }).click();
  await expect(page.getByTestId('run-mode')).toHaveText('模拟用户回答中');
  await expect(page.getByTestId('message-system').last()).toContainText('对话交还给模拟用户');
  await page.getByTestId('run-stages').scrollIntoViewIfNeeded();
  await shot(page, '14-released');

  await page.getByRole('button', { name: '取消运行' }).click();
  await expect(page.getByTestId('run-status').first()).toHaveAttribute('data-status', 'cancelled', {
    timeout: 120_000,
  });
});

test('05 已评分的 run 与对比', async ({ page }) => {
  await page.goto(`/runs/${gradedRun}`);
  await expect(page.getByTestId('run-status').first()).toHaveAttribute('data-status', 'succeeded');
  await shot(page, '15-run-graded');
  const grades = page.getByTestId('run-grades');
  await expect(grades).toContainText('合计 73 / 84');
  await grades.scrollIntoViewIfNeeded();
  await shot(page, '16-run-grades');

  await page.goto('/compare');
  await expect(page.getByTestId('compare-body')).toHaveAttribute('data-refreshing', 'false');
  await expect(page.getByTestId('score-table')).toBeVisible();
  // W4 的 lfg run 在 ticketing 中引用了另一个 run 的工单，默认被排除
  await page.getByRole('checkbox', { name: '包含参考了其他 run 的 run' }).check();
  await expect(page.getByTestId('compare-body')).toHaveAttribute('data-refreshing', 'false');
  await expect(page.getByTestId('score-row-lfg-calculator').getByTestId('run-dot')).toHaveCount(1);
  await shot(page, '17-compare-scores');
  const costs = page.locator('section', {
    has: page.getByRole('heading', { level: 2, name: '各阶段成本' }),
  });
  await costs.scrollIntoViewIfNeeded();
  await shot(page, '18-compare-costs');
});
