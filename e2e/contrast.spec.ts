import { randomUUID } from 'node:crypto';
import { checkContrast } from './contrast.js';
import { expect, test } from './test.js';
import { serverPort } from '../ports.js';

// 对比度（WCAG AA，明暗两种主题）：chromium 这一对服务上的 Workflows 列表与详情、variant 页面（Markdown 预览、并排、
// 编辑、diff 的统一与并排、全屏）。同一对服务上的其余页面见 contrast-pages.spec.ts；Sessions、Runs 的详情、Compare、
// Live 的列表与全屏、分析报告在有数据的那几对服务上检查（contrast-runs.spec.ts 与各自的 spec）
const api = `http://127.0.0.1:${String(serverPort)}/api`;
const marker = randomUUID().slice(0, 8);
const workflowId = `w55-${marker}`;
const stage = `scan-${marker}`;
const skill = `skills/${stage}/SKILL.md`;
let variantId = '';

test.setTimeout(180_000);

const markdown = [
  '---',
  `name: ${stage}`,
  'description: 逐个文件扫描',
  '---',
  '',
  `# 扫描 ${marker}`,
  '',
  '一段说明，含 `行内代码`、[链接](checklist.md) 与 **加粗**。',
  '',
  '> 引用的一段',
  '',
  '| 输入 | 输出 |',
  '| --- | --- |',
  '| 文件 | 发现 |',
  '',
  '- [x] 已完成',
  '- [ ] 未完成',
  '',
  '```ts',
  '// 注释',
  'const files = await list("src");',
  '```',
  '',
  '```mermaid',
  'flowchart LR',
  '  A[列出] --> B[扫描]',
  '```',
  '',
].join('\n');

test.beforeAll(async ({ request }) => {
  const created = await request.post(`${api}/workflows`, {
    data: {
      id: workflowId,
      name: `W55 ${marker}`,
      description: '对比度检查',
      definition: { id: workflowId, name: `W55 ${marker}`, stages: [{ id: stage }] },
    },
  });
  expect(created.status()).toBe(201);
  const variants = (await (await request.get(`${api}/variants`)).json()) as {
    id: string;
    name: string;
    workflowId: string;
  }[];
  const first = variants.find((v) => v.workflowId === workflowId && v.name === '初稿');
  if (first === undefined) throw new Error(`workflow ${workflowId} 没有初稿`);
  const derived = (await (
    await request.post(`${api}/variants/${first.id}/derive`, { data: { name: `W55 ${marker}` } })
  ).json()) as { id: string };
  variantId = derived.id;
  for (const [path, content] of [
    [skill, markdown],
    [`skills/${stage}/checklist.md`, `# 检查清单\n\n- [ ] 每个文件都看过\n`],
    [`skills/${stage}/scan.sh`, '#!/bin/sh\n# 扫描\necho "scan" $1\n'],
  ] as const) {
    const response = await request.put(`${api}/variants/${variantId}/file`, {
      data: { path, content },
    });
    expect(response.status()).toBe(200);
  }
});

test('Workflows 列表与详情', async ({ page }) => {
  await page.goto('/workflows');
  const row = page.getByTestId(`workflow-row-${workflowId}`);
  await row.getByRole('button', { name: `展开 W55 ${marker} 的 variant` }).click();
  await expect(page.getByTestId(`workflow-variants-${workflowId}`)).toBeVisible();
  await checkContrast(page, 'workflows', { screenshot: true });

  await page.goto('/workflows/lfg');
  await expect(page.getByTestId('stage-flow')).toBeVisible();
  await checkContrast(page, 'workflow-detail', { screenshot: true });
});

test('variant 页面：预览、并排、编辑、diff（统一与并排）、全屏', async ({ page }) => {
  await page.goto(`/variants/${variantId}?file=${encodeURIComponent(skill)}`);
  const workspace = page.getByTestId('skill-workspace');
  const view = workspace.getByTestId('workspace-view');
  const article = workspace.getByTestId('md-preview').getByTestId('markdown');
  await expect(article.getByTestId('mermaid').locator('svg')).toBeVisible();
  await checkContrast(page, 'variant-preview', { screenshot: true });

  await view.getByRole('tab', { name: '并排' }).click();
  await expect(workspace.getByTestId('skill-editor').locator('.view-lines')).toContainText(
    `扫描 ${marker}`,
  );
  await checkContrast(page, 'variant-split', { screenshot: true });

  await page.goto(`/variants/${variantId}?file=${encodeURIComponent(`skills/${stage}/scan.sh`)}`);
  await expect(workspace.getByTestId('skill-editor').locator('.view-lines')).toContainText('echo');
  await checkContrast(page, 'variant-edit', { screenshot: true });

  await workspace.getByRole('tab', { name: '对比' }).click();
  const diff = workspace.getByTestId('skill-diff');
  await expect(diff.getByTestId('diff-file')).toHaveCount(3);
  const typeToggle = workspace.getByTestId('diff-view-type');
  await typeToggle.getByRole('button', { name: '统一' }).click();
  await expect(diff.locator('table.diff-unified').first()).toBeVisible();
  await checkContrast(page, 'variant-diff-unified', { screenshot: true });
  await typeToggle.getByRole('button', { name: '并排' }).click();
  await expect(diff.locator('table.diff-split').first()).toBeVisible();
  await checkContrast(page, 'variant-diff-split', { screenshot: true });

  await page.goto(`/variants/${variantId}?file=${encodeURIComponent(skill)}&fullscreen=1`);
  await expect(workspace).toHaveAttribute('data-fullscreen', 'true');
  await view.getByRole('tab', { name: '预览' }).click();
  await expect(article.getByTestId('mermaid').locator('svg')).toBeVisible();
  await checkContrast(page, 'variant-fullscreen-preview', { screenshot: true });
});
