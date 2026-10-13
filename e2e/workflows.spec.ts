import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from './test.js';
import { serverPort } from '../ports.js';

const api = `http://127.0.0.1:${String(serverPort)}/api`;
const marker = randomUUID().slice(0, 8);
// 从空白新建的 workflow：没有评测类型，只用于 Live、阶段划分与分析（Contracts 18.5）
const custom = `myreview-${marker}`;
const definition = {
  id: custom,
  name: `我的评审 ${marker}`,
  stages: [
    { id: `scan-${marker}` },
    { id: `fix-${marker}`, repeatable: true, allowInside: [`scan-${marker}`] },
    { id: `report-${marker}` },
  ],
};
const [scan, fix, report] = definition.stages.map((s) => s.id) as [string, string, string];

interface Workflow {
  id: string;
  name: string;
  description: string | null;
  definition: { id: string; name: string; stages: { id: string }[] };
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  const created = await request.post(`${api}/workflows`, {
    data: { id: custom, name: definition.name, description: '扫描、修复、报告', definition },
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

const flowNodes = (page: Page) =>
  page.getByTestId('stage-flow').locator('[data-testid^="flow-node-"]');

test('Workflows 列表：描述列；每行展开列出 variant，名字链接到 variant 页面', async ({ page }) => {
  await page.goto('/workflows');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Workflows');
  const table = page.getByTestId('workflows-table');
  await expect(table.locator('thead th')).toHaveText([
    '名字',
    '描述',
    '入口命令',
    '评测类型',
    '小阶段数',
    'variant 数',
  ]);
  const rows = table.locator('tbody > tr');
  await expect(rows.nth(0)).toHaveAttribute('data-testid', 'workflow-row-lfg');
  await expect(rows.nth(1)).toHaveAttribute('data-testid', 'workflow-row-ic');
  await expect(page.getByTestId('workflow-row-lfg').locator('td').nth(1)).toHaveText(
    /^从一个新想法到 Linear 工单/,
  );
  const row = page.getByTestId(`workflow-row-${custom}`);
  await expect(row.locator('td')).toHaveText([
    `我的评审 ${marker}`,
    '扫描、修复、报告',
    `/${custom}`,
    '无（不评测）',
    '3',
    '1',
  ]);
  // 新建只有从空白新建与用 Codex 生成
  await expect(page.getByRole('button', { name: '从空白新建' })).toBeEnabled();
  await expect(page.getByRole('button', { name: '用 Codex 生成 workflow' })).toBeEnabled();
  await expect(page.getByRole('button', { name: /复制/ })).toHaveCount(0);

  await row.getByRole('button', { name: `展开 我的评审 ${marker} 的 variant` }).click();
  const expanded = page.getByTestId(`workflow-variants-${custom}`);
  await expect(expanded.locator('thead th')).toHaveText([
    '名字',
    '描述',
    '状态',
    '构建',
    '构建时间',
    '绑定的 session',
  ]);
  await expect(expanded.getByTestId('variant-row-初稿').locator('td')).toHaveText([
    '初稿',
    '',
    '草稿',
    '未构建',
    '—',
    '0',
  ]);
  await page.screenshot({
    path: '.work/screenshots/w44-workflows-expanded.png',
    animations: 'disabled',
  });
  await expanded.getByRole('link', { name: '初稿', exact: true }).click();
  await expect(page).toHaveURL(/\/variants\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('breadcrumb')).toHaveText(`Workflows › 我的评审 ${marker} › 初稿`);

  // /variants 没有单独的页面
  await page.goto('/variants');
  await expect(page).toHaveURL(/\/workflows$/);
});

test('内置的 workflow：定义只读、描述可以改；流程图画出 repeatable 自环与 allowInside 往返边；没有 task 列表', async ({
  page,
  request,
}) => {
  await page.goto('/workflows/ic');
  await expect(page.getByTestId('workflow-summary')).toHaveText('入口 /ic · 评测类型 ic');
  const config = page.getByTestId('workflow-config');
  await expect(config.getByText('内置的 workflow 只能改描述')).toBeVisible();
  await expect(config.getByRole('button', { name: '保存', exact: true })).toHaveCount(0);
  const form = page.getByTestId('workflow-form');
  await expect(form.getByLabel('名字')).toBeDisabled();
  await expect(form.getByRole('button', { name: /去掉小阶段/ })).toHaveCount(0);
  await expect(form.getByRole('combobox', { name: '要加入的小阶段' })).toHaveCount(0);
  await expect(page.getByTestId('workflow-tasks')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '复制为新 workflow' })).toHaveCount(0);

  // 流程图：入口 /ic 之后按顺序 7 个小阶段；fix-pr 自环；fix-pr 到 acceptance 的往返虚线，标注"不算切换"
  await expect(flowNodes(page)).toHaveText([
    '/ic',
    'claim',
    'readiness',
    'implement',
    'acceptance',
    'open-pr',
    'fix-pr',
    'ready-for-review',
  ]);
  const flow = page.getByTestId('stage-flow');
  await expect(flow.getByTestId('rf__edge-seq:ic->claim')).toBeAttached();
  await expect(flow.getByTestId('rf__edge-seq:fix-pr->ready-for-review')).toBeAttached();
  await expect(flow.getByTestId('rf__edge-loop:fix-pr')).toBeAttached();
  await expect(flow.locator('[data-testid^="rf__edge-loop:"]')).toHaveCount(1);
  const inside = flow.getByTestId('flow-inside-inside:fix-pr->acceptance');
  await expect(inside).toContainText('不算切换');
  await expect(inside.locator('path[style*="stroke-dasharray"]')).toHaveCount(2);
  await flow.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '.work/screenshots/w44-flow.png', animations: 'disabled' });

  // YAML 也只读
  await config.getByRole('tab', { name: 'YAML' }).click();
  const yaml = page.getByTestId('workflow-yaml');
  await expect(yaml.locator('.view-lines')).toContainText('id: ic');
  await yaml.locator('.view-lines').click();
  await page.keyboard.type('改不了');
  await expect(yaml.locator('.view-lines')).not.toContainText('改不了');

  // 描述可以改；改回原样
  const before = ((await (await request.get(`${api}/workflows/ic`)).json()) as Workflow)
    .description;
  const editor = page.getByTestId('description-editor');
  await editor.getByRole('textbox', { name: '描述' }).fill(`e2e 描述 ${marker}`);
  await editor.getByRole('button', { name: '保存描述' }).click();
  await expect(editor.getByTestId('description-saved')).toBeVisible();
  const saved = (await (await request.get(`${api}/workflows/ic`)).json()) as Workflow;
  expect(saved.description).toBe(`e2e 描述 ${marker}`);
  await request.put(`${api}/workflows/ic`, {
    data: { name: saved.name, description: before ?? '', definition: saved.definition },
  });
});

test('表单与 YAML 编辑同一份定义，流程图随之更新；YAML 写错时显示原文错误', async ({
  page,
  request,
}) => {
  await page.goto(`/workflows/${custom}`);
  await expect(page.getByTestId('workflow-summary')).toHaveText(
    `入口 /${custom} · 评测类型 无（不评测）`,
  );
  const config = page.getByTestId('workflow-config');
  const form = page.getByTestId('workflow-form');
  const stages = form.getByRole('list', { name: '小阶段' }).locator('li');
  await expect(stages.locator('span.font-mono')).toHaveText([scan, fix, report]);
  await expect(flowNodes(page)).toHaveText([`/${custom}`, scan, fix, report]);
  const flow = page.getByTestId('stage-flow');
  await expect(flow.getByTestId(`rf__edge-loop:${fix}`)).toBeAttached();
  await expect(flow.getByTestId(`flow-inside-inside:${fix}->${scan}`)).toBeAttached();

  // 拖动 report 到最前，scan 设为 repeatable，report 中允许 scan：流程图跟着变
  await form.getByTestId(`stage-${report}`).dragTo(form.getByTestId(`stage-${scan}`));
  await expect(stages.locator('span.font-mono')).toHaveText([report, scan, fix]);
  await expect(flowNodes(page)).toHaveText([`/${custom}`, report, scan, fix]);
  await expect(flow.getByTestId(`rf__edge-seq:${custom}->${report}`)).toBeAttached();
  await form.getByTestId(`stage-${scan}`).getByRole('checkbox', { name: 'repeatable' }).check();
  await expect(flow.getByTestId(`rf__edge-loop:${scan}`)).toBeAttached();
  await form.getByRole('checkbox', { name: `${report} 中允许 ${scan}` }).check();
  await expect(flow.getByTestId(`flow-inside-inside:${report}->${scan}`)).toContainText('不算切换');
  await page.screenshot({
    path: '.work/screenshots/w44-workflow-form.png',
    fullPage: true,
    animations: 'disabled',
  });

  await config.getByRole('tab', { name: 'YAML' }).click();
  const lines = page.getByTestId('workflow-yaml').locator('.view-lines');
  await expect(lines).toContainText(`- id: ${report}    allowInside:      - ${scan}`);

  // YAML 语法错误：yaml 库的原文与行号；流程图停在说明
  await replaceYaml(page, `id: ${custom}: x`);
  const issues = page.getByTestId('workflow-issues');
  await expect(issues).toContainText(
    '第 1 行：Nested mappings are not allowed in compact mappings at line 1, column',
  );
  await expect(config.getByRole('button', { name: '保存', exact: true })).toBeDisabled();
  await expect(page.getByTestId('stage-flow')).toHaveCount(0);
  await expect(config.getByText('定义有错误，修正后显示流程图。')).toBeVisible();

  // 定义的校验错误：服务端 schema 的原文，带上路径
  await replaceYaml(page, `{id: ${custom}, name: x, stages: [{id: plan, allowInside: [nope]}]}`);
  await expect(issues).toHaveText(
    '第 1 行：stages.0.allowInside：小阶段 plan 的 allowInside 引用了不存在的小阶段 nope',
  );

  // 改对后表单与流程图显示 YAML 的内容，保存后服务端是同一份定义
  await replaceYaml(
    page,
    `{id: ${custom}, name: 评审 ${marker}, stages: [{id: ${scan}}, {id: ${fix}, repeatable: true, allowInside: [${scan}]}]}`,
  );
  await expect(issues).toHaveCount(0);
  await expect(flowNodes(page)).toHaveText([`/${custom}`, scan, fix]);
  await config.getByRole('tab', { name: '表单' }).click();
  await expect(form.getByLabel('名字')).toHaveValue(`评审 ${marker}`);
  await expect(stages.locator('span.font-mono')).toHaveText([scan, fix]);
  await config.getByRole('button', { name: '保存', exact: true }).click();
  await expect(page.getByTestId('workflow-saved')).toBeVisible();
  const saved = (await (await request.get(`${api}/workflows/${custom}`)).json()) as Workflow;
  expect(saved.definition).toEqual({
    id: custom,
    name: `评审 ${marker}`,
    stages: [{ id: scan }, { id: fix, repeatable: true, allowInside: [scan] }],
  });
  expect(saved.description).toBe('扫描、修复、报告');
  // workflow 页面只列出 variant 并链接过去，不在页面内展开
  const variants = page.getByTestId('workflow-variants');
  await expect(variants.getByRole('link', { name: '初稿', exact: true })).toHaveAttribute(
    'href',
    /^\/variants\/[0-9a-f-]{36}$/,
  );
  await expect(page.getByTestId('variant-panel')).toHaveCount(0);
  await expect(page.getByTestId('import-baseline')).toHaveCount(0);
});

test('从空白新建：填 id、名字、描述与小阶段，建出 workflow 与第一个 variant「初稿」', async ({
  page,
  request,
}) => {
  const id = `blank-${marker}`;
  await page.goto('/workflows');
  await page.getByRole('button', { name: '从空白新建' }).click();
  const form = page.getByTestId('new-workflow');
  await form.getByLabel('id（入口命令 /id，也是入口 skill 的名字）').fill(id);
  await form.getByLabel('描述').fill('收集、起草');
  await form.getByLabel('名字', { exact: true }).fill(`空白 ${marker}`);
  const add = form.getByRole('combobox', { name: '要加入的小阶段' });
  for (const stage of ['gather', 'draft']) {
    await add.fill(stage);
    await form.getByRole('button', { name: '加入小阶段' }).click();
  }
  await form.getByTestId('stage-draft').getByRole('checkbox', { name: 'repeatable' }).check();
  await expect(flowNodes(page)).toHaveText([`/${id}`, 'gather', 'draft']);
  await expect(page.getByTestId('stage-flow').getByTestId('rf__edge-loop:draft')).toBeAttached();
  await page.screenshot({ path: '.work/screenshots/w44-new-blank.png', animations: 'disabled' });
  await form.getByRole('button', { name: '新建', exact: true }).click();

  await expect(page).toHaveURL(new RegExp(`/workflows/${id}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`空白 ${marker}`);
  const created = (await (await request.get(`${api}/workflows/${id}`)).json()) as Workflow & {
    evalKind: string | null;
  };
  expect(created).toMatchObject({
    evalKind: null,
    description: '收集、起草',
    definition: { id, stages: [{ id: 'gather' }, { id: 'draft', repeatable: true }] },
  });
  await page.getByTestId('workflow-variants').getByRole('link', { name: '初稿' }).click();
  const tree = page.getByRole('navigation', { name: 'skills 文件' });
  for (const name of [id, 'gather', 'draft']) {
    await expect(tree.getByRole('button', { name, exact: true })).toBeVisible();
  }
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
  await expect(form.getByTestId('save-as-task')).toHaveCount(0);
  await expect(form.getByTestId('live-model')).toHaveValue('opus');
  await expect(form.getByTestId('live-effort')).toHaveValue('high');
  await form.getByRole('textbox', { name: '问题' }).fill('做一个计算器');
  await expect(form.getByTestId('live-initial')).toHaveText('/lfg 做一个计算器');

  await workflow.selectOption(custom);
  await expect(form.getByTestId('live-isolated-note')).toContainText(
    '没有评测类型：只建空的 workspace。',
  );
  await expect(form.getByTestId('live-no-variant')).toContainText(
    `/${custom} 还没有构建成功的 variant。`,
  );
  await expect(form.getByTestId('live-start')).toBeDisabled();
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
  const restored = await request.put(`${api}/settings`, {
    data: { ...saved, agentModel: 'opus', agentEffort: 'high' },
  });
  expect(restored.ok()).toBe(true);
});
