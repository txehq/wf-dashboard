import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import { serverPort } from '../ports.js';

const api = `http://127.0.0.1:${String(serverPort)}/api`;
const marker = randomUUID().slice(0, 8);
// 不保留评测类型的副本：只用于 Live、阶段划分与分析（Contracts 16.1）
const custom = `myreview-${marker}`;

interface Variant {
  id: string;
  name: string;
  workflowId: string;
}
interface Workflow {
  id: string;
  name: string;
  definition: { id: string; name: string; stages: { id: string }[] };
}

// 导入基线要从 txe-workflow 复制 src/
test.setTimeout(300_000);
test.describe.configure({ mode: 'serial' });

let base: Variant;

test.beforeAll(async ({ request }) => {
  base = (await (
    await request.post(`${api}/variants`, { data: { name: `e2e 来源 ${marker}` } })
  ).json()) as Variant;
  const lfg = (await (await request.get(`${api}/workflows/lfg`)).json()) as Workflow;
  const created = await request.post(`${api}/workflows`, {
    data: {
      id: custom,
      name: `我的评审 ${marker}`,
      fromVariantId: base.id,
      keepEvalKind: false,
      definition: { ...lfg.definition, id: custom, name: `我的评审 ${marker}` },
    },
  });
  expect(created.status()).toBe(201);
});

// Monaco 中整体换成一行 YAML（flow 写法：键入换行时 Monaco 会自动缩进；括号逐字键入时覆盖自动补上的闭括号）。
// macOS 上 Playwright 把 Meta 组合键作为浏览器的原生编辑命令执行，Monaco 收不到，所以用鼠标选中全文：
// 点在第一行行首，再按住 Shift 点在最后一行之下（落在文末）
async function replaceYaml(page: Page, text: string) {
  const editor = page.getByTestId('workflow-yaml');
  await editor.locator('.view-lines').click({ position: { x: 1, y: 2 } });
  const box = await editor.boundingBox();
  if (box === null) throw new Error('YAML 编辑器不可见');
  await editor.click({ position: { x: box.width / 2, y: box.height - 8 }, modifiers: ['Shift'] });
  // 先删去选中的全文：带着选区键入 { 时 Monaco 会用括号包住选区
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(text);
}

test('Workflows 列表：内置的 lfg、ic 在前，列出入口命令、评测类型与数量，Codex 生成先不可点', async ({
  page,
}) => {
  await page.goto('/workflows');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workflows');
  const table = page.getByTestId('workflows-table');
  await expect(table.locator('thead th')).toHaveText([
    '名字',
    '入口命令',
    '评测类型',
    '小阶段数',
    'variant 数',
  ]);
  const rows = table.locator('tbody tr');
  await expect(rows.nth(0)).toHaveAttribute('data-testid', 'workflow-row-lfg');
  await expect(rows.nth(1)).toHaveAttribute('data-testid', 'workflow-row-ic');
  await expect(page.getByTestId('workflow-row-lfg').locator('td')).toHaveText([
    'lfg内置',
    '/lfg',
    'lfg',
    '4',
    /^\d+$/,
  ]);
  await expect(page.getByTestId(`workflow-row-${custom}`).locator('td')).toHaveText([
    `我的评审 ${marker}`,
    `/${custom}`,
    '无（不评测）',
    '4',
    '1',
  ]);
  await expect(page.getByRole('button', { name: '用 Codex 生成 workflow' })).toBeDisabled();
  await page.screenshot({ path: '.work/screenshots/w41-workflows.png', animations: 'disabled' });

  await page.getByRole('link', { name: 'ic', exact: true }).click();
  await expect(page).toHaveURL(/\/workflows\/ic$/);
});

test('内置的 workflow 只读：表单与 YAML 都不能改，可以复制为新 workflow', async ({ page }) => {
  await page.goto('/workflows/ic');
  await expect(page.getByTestId('workflow-summary')).toHaveText('入口 /ic · 评测类型 ic');
  const config = page.getByTestId('workflow-config');
  await expect(config.getByText('内置的 workflow 只读')).toBeVisible();
  await expect(config.getByRole('button', { name: '保存' })).toHaveCount(0);
  const form = page.getByTestId('workflow-form');
  await expect(form.getByLabel('名字')).toBeDisabled();
  await expect(form.getByRole('button', { name: /去掉小阶段/ })).toHaveCount(0);
  await expect(form.getByRole('combobox', { name: '要加入的小阶段' })).toHaveCount(0);
  await expect(form.getByRole('checkbox', { name: 'fix-pr 中允许 acceptance' })).toBeChecked();
  await expect(form.getByRole('checkbox', { name: 'fix-pr 中允许 acceptance' })).toBeDisabled();

  await config.getByRole('tab', { name: 'YAML' }).click();
  const yaml = page.getByTestId('workflow-yaml');
  await expect(yaml.locator('.view-lines')).toContainText('id: ic');
  await yaml.locator('.view-lines').click();
  await page.keyboard.type('改不了');
  await expect(yaml.locator('.view-lines')).not.toContainText('改不了');

  await page.getByRole('button', { name: '复制为新 workflow' }).click();
  await expect(page.getByTestId('new-workflow')).toBeVisible();
  await expect(page.getByRole('button', { name: '用 Codex 生成 variant' })).toBeDisabled();
});

test('表单与 YAML 编辑同一份定义：拖动排序、勾选反映到 YAML，YAML 的修改反映到表单；写错时显示原文错误', async ({
  page,
  request,
}) => {
  await page.goto(`/workflows/${custom}`);
  await expect(page.getByTestId('workflow-summary')).toHaveText(
    `入口 /${custom} · 评测类型 无（不评测） · 复制自 lfg`,
  );
  // 没有评测类型：不列出可用的 task
  await expect(page.getByTestId('workflow-tasks')).toHaveCount(0);
  const config = page.getByTestId('workflow-config');
  const form = page.getByTestId('workflow-form');
  const stages = form.getByRole('list', { name: '小阶段' }).locator('li');
  await expect(stages.locator('span.font-mono')).toHaveText([
    'interview',
    'research',
    'plan',
    'ticketing',
  ]);

  // 拖动 plan 到最前，research 设为 repeatable，plan 中允许 interview
  await form.getByTestId('stage-plan').dragTo(form.getByTestId('stage-interview'));
  await expect(stages.locator('span.font-mono')).toHaveText([
    'plan',
    'interview',
    'research',
    'ticketing',
  ]);
  await form.getByTestId('stage-research').getByRole('checkbox', { name: 'repeatable' }).check();
  await form.getByRole('checkbox', { name: 'plan 中允许 interview' }).check();
  await page.screenshot({
    path: '.work/screenshots/w41-workflow-form.png',
    animations: 'disabled',
  });

  await config.getByRole('tab', { name: 'YAML' }).click();
  const lines = page.getByTestId('workflow-yaml').locator('.view-lines');
  await expect(lines).toContainText(
    'stages:  - id: plan    allowInside:      - interview  - id: interview  - id: research    repeatable: true  - id: ticketing',
  );
  await page.screenshot({
    path: '.work/screenshots/w41-workflow-yaml.png',
    animations: 'disabled',
  });

  // YAML 语法错误：yaml 库的原文与行号
  await replaceYaml(page, `id: ${custom}: x`);
  const issues = page.getByTestId('workflow-issues');
  await expect(issues).toContainText(
    '第 1 行：Nested mappings are not allowed in compact mappings at line 1, column',
  );
  await expect(config.getByRole('button', { name: '保存' })).toBeDisabled();
  await expect(page.getByTestId('workflow-yaml').locator('.squiggly-error')).not.toHaveCount(0);
  await config.getByRole('tab', { name: '表单' }).click();
  await expect(config.getByText('YAML 中有错误，修正后表单才能显示。')).toBeVisible();

  // 定义的校验错误：服务端 schema 的原文，带上路径
  await config.getByRole('tab', { name: 'YAML' }).click();
  await replaceYaml(page, `{id: ${custom}, name: x, stages: [{id: plan, allowInside: [nope]}]}`);
  await expect(issues).toHaveText(
    '第 1 行：stages.0.allowInside：小阶段 plan 的 allowInside 引用了不存在的小阶段 nope',
  );

  // 改对后表单显示 YAML 的内容，保存后服务端是同一份定义
  await replaceYaml(
    page,
    `{id: ${custom}, name: 评审 ${marker}, stages: [{id: research}, {id: plan, repeatable: true, allowInside: [research]}]}`,
  );
  await expect(issues).toHaveCount(0);
  await config.getByRole('tab', { name: '表单' }).click();
  await expect(form.getByLabel('名字')).toHaveValue(`评审 ${marker}`);
  await expect(stages.locator('span.font-mono')).toHaveText(['research', 'plan']);
  await expect(form.getByRole('checkbox', { name: 'plan 中允许 research' })).toBeChecked();
  await expect(
    form.getByTestId('stage-plan').getByRole('checkbox', { name: 'repeatable' }),
  ).toBeChecked();
  await config.getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('workflow-saved')).toBeVisible();
  const saved = (await (await request.get(`${api}/workflows/${custom}`)).json()) as Workflow;
  expect(saved.name).toBe(`评审 ${marker}`);
  expect(saved.definition).toEqual({
    id: custom,
    name: `评审 ${marker}`,
    stages: [{ id: 'research' }, { id: 'plan', repeatable: true, allowInside: ['research'] }],
  });
});

test('variant 按 workflow 分组：/variants 重定向到 Workflows，每个 workflow 页面只列出自己的 variant', async ({
  page,
}) => {
  await page.goto('/variants');
  await expect(page).toHaveURL(/\/workflows$/);

  await page.goto('/workflows/lfg');
  const variants = page.getByTestId('workflow-variants');
  await expect(variants.getByTestId(`variant-row-e2e 来源 ${marker}`)).toBeVisible();
  await expect(variants.getByTestId('variant-row-基线')).toHaveCount(0);
  await expect(variants.locator('thead th')).toHaveText([
    '名字',
    '状态',
    '构建',
    '构建时间',
    '绑定的 session',
  ]);
  // 有评测类型：列出 kind 为 lfg 的 task
  await expect(page.getByTestId('workflow-tasks')).toContainText('lfg-calculator');

  await page.goto(`/workflows/${custom}`);
  const own = page.getByTestId('workflow-variants');
  await expect(own.locator('tbody tr')).toHaveCount(1);
  await expect(own.getByTestId('variant-row-基线').locator('td')).toHaveText([
    '基线',
    '草稿',
    '未构建',
    '—',
    '0',
  ]);
  await own.getByRole('button', { name: '基线', exact: true }).click();
  await expect(page.getByTestId('variant-panel').getByRole('heading', { level: 2 })).toHaveText(
    `基线 (${custom})`,
  );
  await page.screenshot({
    path: '.work/screenshots/w41-variants-grouped.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test('新建交互：先选 workflow 再选它的 variant，一个问题、环境、驾驶者、model 与 effort', async ({
  page,
}) => {
  await page.goto('/live');
  await page.getByTestId('new-live-toggle').click();
  const form = page.getByTestId('new-live');
  const workflow = form.getByTestId('live-workflow');
  await expect(workflow.locator('option')).toContainText(['/lfg（lfg）', '/ic（ic）']);
  await expect(workflow).toHaveValue('lfg');
  await expect(form.getByTestId('live-isolated-note')).toContainText(
    '在 txehq 建空的副本仓库，写入 vault 的 Project Magi Eval；问题作为想法。',
  );
  // 没有 task 的选择，也没有"另存为 task"
  await expect(form.getByTestId('save-as-task')).toHaveCount(0);
  await expect(form.getByRole('combobox', { name: 'task' })).toHaveCount(0);
  // model 与 effort 默认取设置
  await expect(form.getByTestId('live-model')).toHaveValue('opus');
  await expect(form.getByTestId('live-effort')).toHaveValue('high');
  await form.getByTestId('live-model').selectOption('sonnet');
  await form.getByTestId('live-effort').selectOption('low');
  await expect(form.getByTestId('live-model')).toHaveValue('sonnet');

  await form.getByRole('textbox', { name: '问题' }).fill('做一个计算器');
  await expect(form.getByTestId('live-initial')).toHaveText('/lfg 做一个计算器');

  await workflow.selectOption('ic');
  await expect(form.getByTestId('live-isolated-note')).toContainText(
    '问题必须是 Linear 工单地址或编号',
  );
  await expect(form.getByRole('textbox', { name: '问题' })).toHaveAttribute(
    'placeholder',
    /TXE-3777/,
  );

  await workflow.selectOption(custom);
  await expect(form.getByTestId('live-isolated-note')).toContainText(
    '没有评测类型：只建空的 workspace。',
  );
  await expect(form.getByTestId('live-no-variant')).toContainText(
    `/${custom} 还没有构建成功的 variant。`,
  );
  await expect(form.getByTestId('live-start')).toBeDisabled();
  await page.screenshot({ path: '.work/screenshots/w41-live-new.png', animations: 'disabled' });
});

test('设置页编辑 agent 默认的 model 与 effort', async ({ page, request }) => {
  await page.goto('/runs');
  const settings = page.getByTestId('run-settings');
  await settings.locator('summary').click();
  await expect(settings.locator('summary')).toContainText('agent opus/high');
  await settings.getByTestId('settings-model').selectOption('sonnet');
  await settings.getByTestId('settings-effort').selectOption('medium');
  await settings.getByRole('button', { name: '保存设置' }).click();
  await expect(settings.locator('summary')).toContainText('agent sonnet/medium');
  const saved = (await (await request.get(`${api}/settings`)).json()) as {
    agentModel: string;
    agentEffort: string;
  };
  expect(saved).toMatchObject({ agentModel: 'sonnet', agentEffort: 'medium' });
  await page.screenshot({ path: '.work/screenshots/w41-settings.png', animations: 'disabled' });

  // 新建交互的默认值随之改变
  await page.goto('/live');
  await page.getByTestId('new-live-toggle').click();
  await expect(page.getByTestId('live-model')).toHaveValue('sonnet');
  await expect(page.getByTestId('live-effort')).toHaveValue('medium');

  const restored = await request.put(`${api}/settings`, {
    data: { ...saved, agentModel: 'opus', agentEffort: 'high' },
  });
  expect(restored.ok()).toBe(true);
});
