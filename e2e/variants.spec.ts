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

// 导入 lfg 的基线要从 txe-workflow 复制 src/
test.setTimeout(300_000);

test('variant 页面：任意 workflow 的 variant 编辑描述与 skill、派生、对比、用自有管理器构建；安装到本机的状态', async ({
  page,
  request,
}) => {
  const id = `own-${marker}`;
  const stage = `scan-${marker}`;
  const created = await request.post(`${api}/workflows`, {
    data: {
      id,
      name: `自有 ${marker}`,
      description: '',
      definition: { id, name: `自有 ${marker}`, stages: [{ id: stage }] },
    },
  });
  expect(created.status()).toBe(201);

  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('dialog', (dialog) => {
    if (dialog.type() === 'prompt') void dialog.accept(`第二版 ${marker}`);
    else void dialog.accept();
  });
  await page.setViewportSize({ width: 1440, height: 900 });

  // 从 workflow 页面的 variant 列表进入独立的 variant 页面（Contracts 18.3）
  await page.goto(`/workflows/${id}`);
  await page.getByTestId('workflow-variants').getByRole('link', { name: '初稿' }).click();
  await expect(page).toHaveURL(/\/variants\/[0-9a-f-]{36}$/);
  const first = page.url().split('/').at(-1) ?? '';
  await expect(page.getByTestId('breadcrumb')).toHaveText(`Workflows › 自有 ${marker} › 初稿`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`初稿 /${id}`);
  // variant 页面属于 Workflows：左侧导航高亮它，标签页标题取它
  const nav = page.getByRole('navigation', { name: '主导航' });
  await expect(nav.getByRole('link', { name: 'Workflows' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(nav.getByRole('link', { name: 'Sessions' })).not.toHaveAttribute('aria-current');
  await expect(page).toHaveTitle('Workflows · Magi Workflow Dashboard');
  await expect(page.getByTestId('variant-version')).toHaveText(/^skills\.[0-9a-f]{8}$/);

  // 描述
  const description = page.getByTestId('description-editor');
  await description.getByRole('textbox', { name: '描述' }).fill('第一版');
  await description.getByRole('button', { name: '保存描述' }).click();
  await expect(description.getByTestId('description-saved')).toBeVisible();
  expect(
    ((await (await request.get(`${api}/variants/${first}`)).json()) as { description: string })
      .description,
  ).toBe('第一版');

  // 编辑小阶段的 SKILL.md 并保存
  const panel = page.getByTestId('variant-panel');
  const tree = panel.getByRole('navigation', { name: 'skills 文件' });
  await tree.getByRole('button', { name: stage, exact: true }).click();
  await tree.getByTitle(`skills/${stage}/SKILL.md`).click();
  const editor = panel.getByTestId('skill-editor');
  await expect(editor.locator('.view-lines')).toContainText('在这里写这个阶段做什么。');
  await editor.locator('.view-lines').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(`\n逐个文件扫描 ${marker}。\n`);
  await panel.getByRole('button', { name: '保存', exact: true }).click();
  await expect(panel.getByText('未保存')).toHaveCount(0);

  // 没有基线也没有来源：对比标签说明没有可以对比的内容
  await panel.getByRole('tab', { name: '对比' }).click();
  await expect(panel.getByText('没有可以对比的内容')).toBeVisible();

  // 构建：校验 frontmatter，复制进 variant 自己的配置目录，不用 wf
  const install = page.getByTestId('local-install');
  await expect(install.getByTestId('local-install-status')).toHaveText('没有装在本机');
  await expect(install.getByRole('button', { name: '安装到本机' })).toBeDisabled();
  await panel.getByRole('button', { name: '构建并安装' }).click();
  await expect(panel.getByTestId('build-status')).toHaveText('已构建', { timeout: 60_000 });
  const log = panel.getByTestId('build-log');
  await expect(log).toContainText(`[own] workflow ${id} 的 variant 由 dashboard 管理，没有运行 wf`);
  await expect(log).toContainText('[copy-skills]');
  await expect(log).toContainText('=== 构建完成 skills.');
  await expect(log).not.toContainText('[guard]');
  // 构建通过后可以安装到本机（这里不点：会写进用户真实的 ~/.claude/skills）
  await expect(install.getByRole('button', { name: '安装到本机' })).toBeEnabled();
  await page.screenshot({
    path: '.work/screenshots/w44-variant-page.png',
    fullPage: true,
    animations: 'disabled',
  });
  await install.screenshot({ path: '.work/screenshots/w44-install.png', animations: 'disabled' });

  // 派生：跳到新 variant 的页面，与来源对比列出改过的文件
  await panel.getByRole('button', { name: '另存为新 variant' }).click();
  await expect(page.getByTestId('breadcrumb')).toHaveText(
    `Workflows › 自有 ${marker} › 第二版 ${marker}`,
  );
  expect(page.url()).not.toContain(first);
  const second = page.getByTestId('variant-panel');
  await second.getByRole('tab', { name: '对比' }).click();
  await expect(second.getByRole('button', { name: '与基线对比' })).toHaveCount(0);
  await expect(second.getByText('skills 内容相同，没有差异。')).toBeVisible();
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
  await page.goto(`/variants/${base.id}`);
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
  // 内置 lfg 的 variant 由 wf 管理，没有安装到本机
  await expect(page.getByTestId('local-install')).toHaveCount(0);
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
  await expect(page.getByTestId('breadcrumb')).toHaveText(
    `Workflows › lfg › e2e 切换修改 ${marker}`,
  );
  const panel = page.getByTestId('variant-panel');
  await panel.getByRole('tab', { name: '对比' }).click();
  const diff = panel.getByTestId('skill-diff');
  // Monaco 只渲染视野内的行，改动的文字出现在 view-lines 中即在视野内
  for (const path of ['skills/plan/SKILL.md', 'skills/research/SKILL.md', 'skills/plan/SKILL.md']) {
    await panel.getByRole('button', { name: new RegExp(path.replaceAll('.', '\\.')) }).click();
    await expect(diff.locator('.modified .view-lines')).toContainText(`e2e-${marker}-${path}`);
  }
});
