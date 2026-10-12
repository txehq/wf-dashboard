import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page, test } from '@playwright/test';

// 使用手册各步骤的截图，只用种子数据：数据目录中有 W4 端到端导入的已结束的 run；
// 基线从 txe-workflow 导入，派生的 variant 编辑后在本机构建（不调用模型）。不发起 run：
// 接管与交还的截图（guide-13、guide-14）需要一个正在运行的 run，不由这里生成
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

test('00 导航', async ({ page }) => {
  await page.goto('/runs');
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.reload();
  const nav = page.getByRole('navigation', { name: '主导航' });
  await expect(nav.getByRole('button', { name: 'Evaluate', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(nav.getByRole('link', { name: 'Runs' })).toHaveAttribute('aria-current', 'page');
  await shot(page.getByRole('complementary'), '00-navigation');
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

  // 导入的历史 session 在导入时就划分好阶段：f0aca373 有一轮 /lfg 与三轮 /ic
  await page.getByRole('searchbox', { name: '搜索 session' }).fill('f0aca373');
  const imported = page.getByTestId('session-row').filter({ hasText: 'f0aca373' });
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  await imported.getByRole('link').click();
  await expect(page.getByTestId('cycles-ic').getByRole('tab')).toHaveCount(3);
  await shot(page, '03-session-stages');

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
  // variant 是 workflow 的实例，在所属 workflow 的页面中（Contracts 16.7）
  await page.goto('/workflows');
  await shot(page, '06-workflows');
  await page.getByRole('link', { name: 'lfg', exact: true }).click();
  await page.getByTestId('workflow-variants').getByLabel('名称').fill(baseName);
  await shot(page, '06-variant-import');
  await page.getByRole('button', { name: '导入基线' }).click();
  const panel = page.getByTestId('variant-panel');
  // 展开的 variant 在配置与 variant 列表之下：截图前把它滚到视口顶部
  const showPanel = () =>
    panel.evaluate((el) => {
      el.scrollIntoView({ block: 'start' });
    });
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(`${baseName} (lfg)`, {
    timeout: 120_000,
  });
  // 基线本身也要构建才能运行
  const baseId = new URL(page.url()).searchParams.get('variant') ?? '';
  const built = await request.post(`/api/variants/${baseId}/build`, { timeout: 900_000 });
  expect(((await built.json()) as { buildStatus: string }).buildStatus).toBe('built');

  await page.reload();
  await panel.getByRole('button', { name: '另存为新 variant' }).click();
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(`${modName} (lfg)`);
  await showPanel();
  await shot(page, '07-variant-derived');

  // research 的评审最多两轮：在 research/SKILL.md 中加一条规则
  const tree = panel.getByRole('navigation', { name: 'skills 文件' });
  await tree.getByRole('button', { name: 'research', exact: true }).click();
  await tree.getByTitle('skills/research/SKILL.md').click();
  const editor = panel.getByTestId('skill-editor');
  await expect(editor.locator('.view-lines')).toContainText('name: research');
  await editor.locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(
    '\n\nReview the draft at most twice; after the second review, lock it.\n',
  );
  await expect(panel.getByText('未保存')).toBeVisible();
  await showPanel();
  await shot(page, '08-skill-edit');
  await panel.getByRole('button', { name: '保存' }).click();
  await expect(panel.getByText('未保存')).toHaveCount(0);

  await panel.getByRole('tab', { name: '对比' }).click();
  await expect(panel.getByTestId('skill-diff').locator('.line-insert').first()).toBeVisible();
  await showPanel();
  await shot(page, '09-skill-diff');

  await panel.getByRole('button', { name: '构建并安装' }).click();
  await expect(panel.getByTestId('build-status')).toHaveText('已构建', { timeout: 840_000 });
  await expect(panel.getByTestId('build-log')).toContainText('=== 构建完成');
  await showPanel();
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
  // 只列出 kind 为 lfg 的 task：所选 variant 属于 /lfg（Contracts 16.3）
  await expect(
    launch.getByRole('checkbox', { name: '金额格式化：按币种小数位、负数与大金额' }),
  ).toHaveCount(0);
  await expect(page.getByTestId('launch-summary')).toContainText(
    '2 个 variant × 1 个 task × 3 次 = 6 个 run',
  );
  await shot(launch, '11-launch');

  // run 列表用数据目录中导入的已结束的 run（W4 端到端），不发起新的 run
  const rows = page.getByTestId('run-row');
  await expect(rows.first()).toBeVisible();
  await rows.first().scrollIntoViewIfNeeded();
  await shot(page, '12-run-list');
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
