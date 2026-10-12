import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { serverPort } from '../ports.js';

const api = `http://127.0.0.1:${String(serverPort)}/api`;
const marker = randomUUID().slice(0, 8);

interface Variant {
  id: string;
  name: string;
  workflowId: string;
}

// 真实导入、编辑、构建，首次构建要编译 wf
test.setTimeout(900_000);

test('复制 lfg 为新 workflow，在它的页面中展开 variant：编辑 skill、对比、构建并查看日志', async ({
  page,
  request,
}) => {
  const base = (await (
    await request.post(`${api}/variants`, { data: { name: `e2e 基线 ${marker}` } })
  ).json()) as Variant;
  expect(base.workflowId).toBe('lfg');
  const id = `mylfg-${marker}`;

  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', (dialog) => void dialog.accept());
  await page.setViewportSize({ width: 1440, height: 900 });

  // 新建：选来源 variant，保留评测类型（Contracts 16.7）
  await page.goto('/workflows');
  await page.getByRole('button', { name: '新建 workflow' }).click();
  const form = page.getByTestId('new-workflow');
  await form.getByTestId('new-workflow-source').selectOption({ label: `e2e 基线 ${marker} (lfg)` });
  await form.getByLabel('id（入口命令 /id）').fill(id);
  await form.getByLabel('名字', { exact: true }).fill(`我的 lfg ${marker}`);
  await expect(form.getByLabel(/保留评测类型/)).toBeChecked();
  await expect(form).toContainText(`来源 variant 的入口 skill /lfg 在副本中改名为 /${id}`);
  await form.getByRole('button', { name: '新建' }).click();

  await expect(page).toHaveURL(new RegExp(`/workflows/${id}$`));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`我的 lfg ${marker}`);
  await expect(page.getByTestId('workflow-summary')).toHaveText(
    `入口 /${id} · 评测类型 lfg · 复制自 lfg`,
  );

  // variant 列表只有复制出的第一个 variant；点开后在同一页展开
  const variants = page.getByTestId('workflow-variants');
  await expect(variants.locator('tbody tr')).toHaveCount(1);
  await variants.getByRole('button', { name: '基线', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${id}\\?variant=`));
  const panel = page.getByTestId('variant-panel');
  await expect(panel.getByRole('heading', { level: 2 })).toHaveText(`基线 (${id})`);

  // 入口 skill 目录随 workflow 改名
  const tree = panel.getByRole('navigation', { name: 'skills 文件' });
  await expect(tree.getByRole('button', { name: id, exact: true })).toBeVisible();
  await expect(tree.getByRole('button', { name: 'lfg', exact: true })).toHaveCount(0);

  // 打开 interview/SKILL.md，在末尾追加一行并保存
  await tree.getByRole('button', { name: 'interview', exact: true }).click();
  await tree.getByTitle('skills/interview/SKILL.md').click();
  const editor = panel.getByTestId('skill-editor');
  await expect(editor.locator('.view-lines')).toContainText('name: interview');
  await editor.locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(`\n<!-- e2e ${marker} -->\n`);
  await expect(panel.getByText('未保存')).toBeVisible();
  await panel.getByRole('button', { name: '保存' }).click();
  await expect(panel.getByText('未保存')).toHaveCount(0);
  await expect(panel.getByTestId('build-status')).toHaveText('未构建');
  await page.screenshot({ path: '.work/screenshots/w6-editor.png', animations: 'disabled' });

  const copied = (await (await request.get(`${api}/variants`)).json()) as Variant[];
  const variant = copied.find((v) => v.workflowId === id);
  if (variant === undefined) throw new Error(`没有 workflow ${id} 的 variant`);
  const saved = (await (
    await request.get(`${api}/variants/${variant.id}/file?path=skills/interview/SKILL.md`)
  ).json()) as { content: string };
  expect(saved.content).toContain(`<!-- e2e ${marker} -->`);

  await panel.getByRole('tab', { name: '对比' }).click();
  const diff = panel.getByTestId('skill-diff');
  await panel.getByRole('button', { name: /skills\/interview\/SKILL\.md/ }).click();
  await expect(diff.locator('.modified .view-lines')).toContainText(`<!-- e2e ${marker} -->`);
  await expect(diff.locator('.line-insert').first()).toBeVisible();
  await page.screenshot({ path: '.work/screenshots/w6-diff.png', animations: 'disabled' });

  // 模型与 effort 不属于 variant（Contracts 16.5）
  await expect(panel.getByRole('combobox', { name: 'effort' })).toHaveCount(0);

  // 页面经 /api/events 收到的 variant.build 事件
  await page.evaluate(async () => {
    const received: unknown[] = [];
    Object.assign(globalThis, { variantBuildEvents: received });
    const source = new EventSource('/api/events');
    source.addEventListener('variant.build', (event) => {
      if (!(event instanceof MessageEvent)) throw new Error('variant.build 不是 MessageEvent');
      received.push(JSON.parse(String(event.data)));
    });
    await new Promise((resolve) => {
      source.addEventListener('ready', resolve, { once: true });
    });
  });

  await panel.getByRole('button', { name: '构建并安装' }).click();
  await expect(panel.getByRole('tab', { name: '构建日志' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(panel.getByTestId('build-status')).toHaveText('已构建', { timeout: 840_000 });
  const log = panel.getByTestId('build-log');
  await expect(log).toContainText('=== 构建完成');
  await expect(log).toContainText('[status] exit 0');
  // 改名后的入口 skill 自动登记进 registry 与 docs 名单（Contracts 16.4）
  await expect(panel.getByTestId('registered-skills')).toContainText(
    `自动登记的 skill：登记 ${id}；删去 lfg`,
  );
  await page.screenshot({ path: '.work/screenshots/w6-build-log.png', animations: 'disabled' });
  const buildEvents = await page.evaluate(
    () => (globalThis as unknown as { variantBuildEvents: unknown[] }).variantBuildEvents,
  );
  expect(buildEvents).toContainEqual({
    type: 'variant.build',
    variantId: variant.id,
    status: 'building',
    step: 'install',
  });
  expect(buildEvents.at(-1)).toEqual({
    type: 'variant.build',
    variantId: variant.id,
    status: 'built',
    step: null,
  });

  // 切回对比再离开，DiffEditor 卸载时不应报错
  await panel.getByRole('tab', { name: '对比' }).click();
  await expect(diff.locator('.line-insert').first()).toBeVisible();
  await panel.getByRole('tab', { name: '编辑' }).click();
  await expect(editor).toBeVisible();
  expect(pageErrors).toEqual([]);
});

test('skill 目录的新增、重命名与删除', async ({ page, request }) => {
  const base = (await (
    await request.post(`${api}/variants`, { data: { name: `e2e 目录 ${marker}` } })
  ).json()) as Variant;
  const prompts = ['e2e-extra', 'e2e-renamed'];
  page.on('dialog', (dialog) => {
    if (dialog.type() === 'prompt') void dialog.accept(prompts.shift());
    else void dialog.accept();
  });
  await page.goto(`/workflows/lfg?variant=${base.id}`);
  const panel = page.getByTestId('variant-panel');
  const tree = panel.getByRole('navigation', { name: 'skills 文件' });

  await panel.getByRole('button', { name: '新增 skill 目录' }).click();
  await expect(tree.getByRole('button', { name: 'e2e-extra', exact: true })).toBeVisible();
  await expect(panel.getByTestId('skill-editor').locator('.view-lines')).toContainText(
    'name: e2e-extra',
  );

  await tree.getByRole('button', { name: '重命名 skill e2e-extra' }).click();
  await expect(tree.getByRole('button', { name: 'e2e-renamed', exact: true })).toBeVisible();
  await expect(tree.getByRole('button', { name: 'e2e-extra', exact: true })).toHaveCount(0);
  await expect(panel.getByTestId('skill-editor').locator('.view-lines')).toContainText(
    'name: e2e-renamed',
  );

  await tree.getByRole('button', { name: '删除 skill e2e-renamed' }).click();
  await expect(tree.getByRole('button', { name: 'e2e-renamed', exact: true })).toHaveCount(0);
  const files = (await (await request.get(`${api}/variants/${base.id}/files`)).json()) as {
    path: string;
  }[];
  expect(files.some((f) => f.path.startsWith('skills/e2e-'))).toBe(false);
});

// 切换文件时 DiffEditor 重新创建，第一处改动在文件中部时也要滚动到视野中
test('在对比的文件之间切换，每个文件的第一处改动都在视野内', async ({ page, request }) => {
  const base = (await (
    await request.post(`${api}/variants`, { data: { name: `e2e 切换基线 ${marker}` } })
  ).json()) as Variant;
  const draft = (await (
    await request.post(`${api}/variants/${base.id}/derive`, {
      data: { name: `e2e 切换修改 ${marker}` },
    })
  ).json()) as Variant;
  const edits = [
    { path: 'skills/research/SKILL.md', line: '## 6. Converge before you publish' },
    { path: 'skills/plan/SKILL.md', line: 'neither the user nor a review pass changes the plan.' },
  ];
  for (const edit of edits) {
    const file = (await (
      await request.get(`${api}/variants/${draft.id}/file?path=${edit.path}`)
    ).json()) as { content: string };
    expect(file.content.split(edit.line)).toHaveLength(2);
    const saved = await request.put(`${api}/variants/${draft.id}/file`, {
      data: {
        path: edit.path,
        content: file.content.replace(edit.line, `${edit.line} e2e-${marker}-${edit.path}`),
      },
    });
    expect(saved.ok()).toBe(true);
  }

  // 旧地址 /variants/:id 重定向到所属 workflow 的页面并展开它（Contracts 16.7）
  await page.goto(`/variants/${draft.id}`);
  await expect(page).toHaveURL(new RegExp(`/workflows/lfg\\?variant=${draft.id}$`));
  const panel = page.getByTestId('variant-panel');
  await panel.getByRole('tab', { name: '对比' }).click();
  const diff = panel.getByTestId('skill-diff');
  // Monaco 只渲染视野内的行，改动的文字出现在 view-lines 中即在视野内
  for (const path of ['skills/plan/SKILL.md', 'skills/research/SKILL.md', 'skills/plan/SKILL.md']) {
    await panel.getByRole('button', { name: new RegExp(path.replaceAll('.', '\\.')) }).click();
    await expect(diff.locator('.modified .view-lines')).toContainText(`e2e-${marker}-${path}`);
  }
});
