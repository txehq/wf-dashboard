import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { serverPort } from '../ports.js';

const api = `http://127.0.0.1:${String(serverPort)}/api`;
const marker = randomUUID().slice(0, 8);

interface Variant {
  id: string;
  name: string;
}

// 真实导入、编辑、构建，首次构建要编译 wf
test.setTimeout(900_000);

test('编辑 skill、与基线对比、构建并查看日志', async ({ page, request }) => {
  const base = (await (
    await request.post(`${api}/variants`, { data: { name: `e2e 基线 ${marker}` } })
  ).json()) as Variant;
  const draft = (await (
    await request.post(`${api}/variants/${base.id}/derive`, {
      data: { name: `e2e 修改 ${marker}` },
    })
  ).json()) as Variant;

  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/variants');
  await expect(page.getByRole('link', { name: `e2e 修改 ${marker}` })).toBeVisible();
  await page.getByRole('link', { name: `e2e 修改 ${marker}` }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`e2e 修改 ${marker}`);

  // 打开 interview/SKILL.md，在末尾追加一行并保存
  const tree = page.getByRole('navigation', { name: 'skills 文件' });
  await tree.getByRole('button', { name: 'interview', exact: true }).click();
  await tree.getByTitle('skills/interview/SKILL.md').click();
  const editor = page.getByTestId('skill-editor');
  await expect(editor.locator('.view-lines')).toContainText('name: interview');
  await editor.locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(`\n<!-- e2e ${marker} -->\n`);
  await expect(page.getByText('未保存')).toBeVisible();
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByText('未保存')).toHaveCount(0);
  await expect(page.getByTestId('build-status')).toHaveText('未构建');
  await page.screenshot({ path: '.work/screenshots/w6-editor.png', animations: 'disabled' });

  const saved = (await (
    await request.get(`${api}/variants/${draft.id}/file?path=skills/interview/SKILL.md`)
  ).json()) as { content: string };
  expect(saved.content).toContain(`<!-- e2e ${marker} -->`);

  await page.getByRole('tab', { name: '对比' }).click();
  const diff = page.getByTestId('skill-diff');
  await expect(page.getByText('skills/interview/SKILL.md')).toBeVisible();
  await expect(diff.locator('.modified .view-lines')).toContainText(`<!-- e2e ${marker} -->`);
  await expect(diff.locator('.line-insert').first()).toBeVisible();
  await page.screenshot({ path: '.work/screenshots/w6-diff.png', animations: 'disabled' });

  await page.getByRole('combobox', { name: 'effort' }).selectOption('xhigh');
  await expect(page.getByRole('combobox', { name: 'effort' })).toHaveValue('xhigh');

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

  await page.getByRole('button', { name: '构建并安装' }).click();
  await expect(page.getByRole('tab', { name: '构建日志' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByTestId('build-status')).toHaveText('已构建', { timeout: 840_000 });
  const log = page.getByTestId('build-log');
  await expect(log).toContainText('=== 构建完成');
  await expect(log).toContainText('[status] exit 0');
  await page.screenshot({ path: '.work/screenshots/w6-build-log.png', animations: 'disabled' });
  const buildEvents = await page.evaluate(
    () => (globalThis as unknown as { variantBuildEvents: unknown[] }).variantBuildEvents,
  );
  expect(buildEvents).toContainEqual({
    type: 'variant.build',
    variantId: draft.id,
    status: 'building',
    step: 'install',
  });
  expect(buildEvents.at(-1)).toEqual({
    type: 'variant.build',
    variantId: draft.id,
    status: 'built',
    step: null,
  });

  // 切回对比再离开，DiffEditor 卸载时不应报错
  await page.getByRole('tab', { name: '对比' }).click();
  await expect(diff.locator('.line-insert').first()).toBeVisible();
  await page.getByRole('tab', { name: '编辑' }).click();
  await expect(editor).toBeVisible();
  expect(pageErrors).toEqual([]);
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

  await page.goto(`/variants/${draft.id}`);
  await page.getByRole('tab', { name: '对比' }).click();
  const diff = page.getByTestId('skill-diff');
  // Monaco 只渲染视野内的行，改动的文字出现在 view-lines 中即在视野内
  for (const path of ['skills/plan/SKILL.md', 'skills/research/SKILL.md', 'skills/plan/SKILL.md']) {
    await page.getByRole('button', { name: new RegExp(path.replaceAll('.', '\\.')) }).click();
    await expect(diff.locator('.modified .view-lines')).toContainText(`e2e-${marker}-${path}`);
  }
});
