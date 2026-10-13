import { randomUUID } from 'node:crypto';
import { expect, type Page, type APIRequestContext, test } from './test.js';
import { serverPort } from '../ports.js';

const api = `http://127.0.0.1:${String(serverPort)}/api`;
const shots = '.work/screenshots';
const sizes = [
  { width: 1280, height: 800 },
  { width: 1600, height: 1000 },
] as const;

// 任意 workflow：构建由 dashboard 自己完成，不用 wf，几秒内结束
async function ownWorkflow(request: APIRequestContext) {
  const marker = randomUUID().slice(0, 8);
  const id = `w46-${marker}`;
  const stage = `scan-${marker}`;
  const created = await request.post(`${api}/workflows`, {
    data: {
      id,
      name: `W46 ${marker}`,
      description: '',
      definition: { id, name: `W46 ${marker}`, stages: [{ id: stage }] },
    },
  });
  expect(created.status()).toBe(201);
  const variants = (await (await request.get(`${api}/variants`)).json()) as {
    id: string;
    name: string;
    workflowId: string;
  }[];
  const first = variants.find((v) => v.workflowId === id && v.name === '初稿');
  if (first === undefined) throw new Error(`workflow ${id} 没有初稿`);
  return { marker, id, stage, first: first.id };
}

// 只有一个按钮的一行（Contracts 20.2）：按钮所在的水平带上，按钮之外没有别的文字或控件。
// 文件树、对比的文件列表（nav）、标签、Monaco 内部与 diff 中"展开未改动的行"的按钮是内容的一部分，不算
async function singleButtonRows(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
    };
    const root =
      document.querySelector('[data-fullscreen="true"]') ?? document.querySelector('main');
    if (root === null) throw new Error('页面没有 main');
    const controls = 'button, input, textarea, select, a, svg';
    const leaves = [...root.querySelectorAll('*')].filter(
      (el) =>
        visible(el) &&
        (el.matches(controls) || (el.children.length === 0 && el.textContent.trim() !== '')),
    );
    return [...root.querySelectorAll('button')]
      .filter(
        (b) => visible(b) && b.closest('nav, [role="tablist"], .monaco-editor, .wfd-diff') === null,
      )
      .filter((b) => {
        const r = b.getBoundingClientRect();
        const middle = r.top + r.height / 2;
        return !leaves.some((el) => {
          if (b.contains(el) || el.contains(b)) return false;
          const q = el.getBoundingClientRect();
          return q.top <= middle && q.bottom >= middle;
        });
      })
      .map((b) => b.textContent.trim() || (b.getAttribute('aria-label') ?? ''));
  });
}

async function horizontalScroll(page: Page): Promise<boolean> {
  return page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
}

async function height(page: Page, testId: string): Promise<number> {
  const box = await page.getByTestId(testId).boundingBox();
  if (box === null) throw new Error(`${testId} 不可见`);
  return box.height;
}

test('variant 页面：头部一行是面包屑、名字与四个操作，两种窗口大小都没有单按钮的一行与横向滚动', async ({
  page,
  request,
}) => {
  const { marker, id, first } = await ownWorkflow(request);
  page.on('dialog', (dialog) => {
    void dialog.accept(`派生 ${marker}`);
  });
  await page.goto(`/variants/${first}`);
  const header = page.getByTestId('variant-actions');
  const build = header.getByRole('button', { name: '构建', exact: true });
  const derive = header.getByRole('button', { name: '派生新 variant' });
  const finder = header.getByRole('button', { name: '在访达中打开' });
  const install = header.getByRole('button', { name: '安装到本机' });
  await expect(page.getByTestId('breadcrumb')).toHaveText(`Workflows › W46 ${marker} › 初稿`);
  await expect(install).toBeDisabled();

  for (const size of sizes) {
    await page.setViewportSize(size);
    // 面包屑与四个按钮在同一水平带上
    const crumb = await page.getByRole('heading', { level: 1 }).boundingBox();
    if (crumb === null) throw new Error('标题不可见');
    for (const button of [build, derive, finder, install]) {
      await expect(button).toBeVisible();
      const box = await button.boundingBox();
      if (box === null) throw new Error('按钮不可见');
      expect(Math.abs(box.y + box.height / 2 - (crumb.y + crumb.height / 2))).toBeLessThan(12);
    }
    expect(await singleButtonRows(page)).toEqual([]);
    expect(await horizontalScroll(page)).toBe(false);
    // 编辑区（.md 文件默认预览）占页面高度的大部分
    expect(await height(page, 'file-view')).toBeGreaterThan(size.height * 0.6);
    await page.screenshot({
      path: `${shots}/w46-page-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }

  // 构建：底部的构建日志面板自动打开，构建通过后可以安装到本机（这里不点：会写进用户真实的 ~/.claude/skills）
  await build.click();
  await expect(page.getByTestId('build-status')).toHaveText('已构建', { timeout: 60_000 });
  await expect(page.getByTestId('build-log-panel')).toBeVisible();
  await expect(page.getByTestId('build-log')).toContainText('=== 构建完成 skills.');
  await expect(page.getByTestId('build-log-status')).toHaveText(/ 构建完成$/);
  await expect(install).toBeEnabled();
  await expect(install).toHaveAttribute('title', /~\/\.claude\/skills/);
  // 在访达中打开会在用户的桌面上打开窗口，这里只检查它可以点
  await expect(finder).toBeEnabled();
  expect(await singleButtonRows(page)).toEqual([]);

  // 派生：跳到新 variant 的页面
  await derive.click();
  await expect(page.getByTestId('breadcrumb')).toHaveText(
    `Workflows › W46 ${marker} › 派生 ${marker}`,
  );
  await expect(page).not.toHaveURL(new RegExp(first));
  await expect(page.getByTestId('variant-parent')).toContainText(`初稿 (${id})`);
});

test('全屏编辑 skill：按钮与 ⌃⇧F 进入退出，Esc 不退出，刷新保持；内容、光标与选区不变；文件树、保存、对比与构建日志', async ({
  page,
  request,
}) => {
  const { marker, stage, first } = await ownWorkflow(request);
  const derived = (await (
    await request.post(`${api}/variants/${first}/derive`, { data: { name: `W46 全屏 ${marker}` } })
  ).json()) as { id: string };
  const built = await request.post(`${api}/variants/${derived.id}/build`);
  expect(((await built.json()) as { buildStatus: string }).buildStatus).toBe('built');
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.setViewportSize(sizes[0]);
  await page.goto(`/variants/${derived.id}`);
  const workspace = page.getByTestId('skill-workspace');
  const toggle = workspace.getByTestId('fullscreen-toggle');
  const tree = workspace.getByRole('navigation', { name: 'skills 文件' });
  const lines = workspace.getByTestId('skill-editor').locator('.view-lines');
  const saveState = workspace.getByTestId('save-state');
  const expectFullscreen = async (active: boolean) => {
    await expect(workspace).toHaveAttribute('data-fullscreen', String(active));
    if (active) await expect(page).toHaveURL(/[?&]fullscreen=1/);
    else await expect(page).not.toHaveURL(/fullscreen=/);
  };
  // 全屏时编辑区盖住整个窗口
  const expectCovers = async () => {
    const box = await workspace.boundingBox();
    const size = page.viewportSize();
    if (box === null || size === null) throw new Error('编辑区不可见');
    expect(box).toEqual({ x: 0, y: 0, width: size.width, height: size.height });
  };
  await expect(toggle).toHaveAttribute('title', '全屏（⌃⇧F）');

  await tree.getByRole('button', { name: stage, exact: true }).click();
  await tree.getByTitle(`skills/${stage}/SKILL.md`).click();
  await expect(workspace.getByTestId('current-file')).toHaveText(`skills/${stage}/SKILL.md`);
  // .md 文件默认预览，点"编辑"进入编辑
  await workspace.getByRole('tab', { name: '编辑' }).click();
  await expect(lines).toContainText('在这里写这个阶段做什么。');
  await lines.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(`\nW46${marker}abcde`);
  // 选中 de；进入全屏后输入的字替换选区，即选区未变
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.evaluate(() => {
    window.scrollTo(0, document.documentElement.scrollHeight);
  });
  const scrollY = await page.evaluate(() => window.scrollY);

  await page.keyboard.press('Control+Shift+KeyF');
  await expectFullscreen(true);
  await expectCovers();
  await expect(toggle).toHaveAttribute('title', '退出全屏（⌃⇧F）');
  await page.keyboard.type('QR');
  await expect(lines).toContainText(`W46${marker}abcQR`);
  // 选中 R 后退出全屏，再输入的字替换它
  await page.keyboard.press('Shift+ArrowLeft');
  await page.keyboard.press('Control+Shift+KeyF');
  await expectFullscreen(false);
  expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
  await page.keyboard.type('S');
  await expect(lines).toContainText(`W46${marker}abcQS`);
  await expect(saveState).toHaveText('未保存');

  // 按钮进入；Esc 不退出；未保存的内容还在
  await toggle.click();
  await expectFullscreen(true);
  await page.keyboard.press('Escape');
  await expectFullscreen(true);
  await expect(saveState).toHaveText('未保存');
  await expect(lines).toContainText(`W46${marker}abcQS`);
  expect(await singleButtonRows(page)).toEqual([]);

  // 全屏时保存
  await workspace.getByRole('button', { name: '保存', exact: true }).click();
  await expect(saveState).toHaveText('已保存');
  const file = (await (
    await request.get(
      `${api}/variants/${derived.id}/file?path=${encodeURIComponent(`skills/${stage}/SKILL.md`)}`,
    )
  ).json()) as { content: string };
  expect(file.content).toContain(`W46${marker}abcQS`);

  // 拖动分隔条改变文件树的宽度
  const treeBox = async () => {
    const box = await workspace.getByTestId('file-tree').boundingBox();
    if (box === null) throw new Error('文件树不可见');
    return box;
  };
  const before = (await treeBox()).width;
  const splitter = await workspace.getByTestId('tree-splitter').boundingBox();
  if (splitter === null) throw new Error('分隔条不可见');
  await page.mouse.move(splitter.x + splitter.width / 2, splitter.y + splitter.height / 2);
  await page.mouse.down();
  await page.mouse.move(splitter.x + 120, splitter.y + splitter.height / 2, { steps: 6 });
  await page.mouse.up();
  const dragged = (await treeBox()).width;
  expect(Math.abs(dragged - (before + 120))).toBeLessThan(3);

  // 刷新：仍是全屏，打开的文件与文件树宽度保持
  await page.reload();
  await expectFullscreen(true);
  await expectCovers();
  await expect(workspace.getByTestId('current-file')).toHaveText(`skills/${stage}/SKILL.md`);
  await expect(lines).toContainText(`W46${marker}abcQS`);
  expect(Math.abs((await treeBox()).width - dragged)).toBeLessThan(1);

  // 收起文件树：编辑器（Monaco 重新排版）铺满宽度；再展开
  const editorWidth = async () => {
    const box = await workspace.locator('.monaco-editor').boundingBox();
    if (box === null) throw new Error('编辑器不可见');
    return box.width;
  };
  const narrow = await editorWidth();
  await workspace.getByTestId('tree-toggle').click();
  await expect(workspace.getByTestId('file-tree')).toHaveCount(0);
  await expect.poll(editorWidth).toBeGreaterThan(narrow + dragged - 5);
  await workspace.getByTestId('tree-toggle').click();
  await expect(workspace.getByTestId('file-tree')).toBeVisible();
  await expect.poll(editorWidth).toBeLessThan(narrow + 5);

  // 全屏时与来源对比：列出刚保存的修改；回到编辑
  await workspace.getByRole('tab', { name: '对比' }).click();
  await expect(workspace.getByRole('button', { name: '与来源对比' })).toBeVisible();
  await expect(
    workspace.getByTestId('skill-diff').locator('td.diff-code-insert').last(),
  ).toContainText(`W46${marker}abcQS`);
  expect(await singleButtonRows(page)).toEqual([]);
  await workspace.getByRole('tab', { name: '编辑' }).click();
  await expect(lines).toBeVisible();

  // 两种窗口大小：编辑器占满高度；打开底部的构建日志面板
  const logToggle = workspace.getByTestId('log-toggle');
  for (const size of sizes) {
    await page.setViewportSize(size);
    await expectCovers();
    await expect.poll(() => height(page, 'skill-editor')).toBeGreaterThan(size.height * 0.9);
    expect(await singleButtonRows(page)).toEqual([]);
    expect(await horizontalScroll(page)).toBe(false);
    await page.screenshot({
      path: `${shots}/w46-fullscreen-${String(size.width)}.png`,
      animations: 'disabled',
    });
    await logToggle.click();
    await expect(logToggle).toHaveAttribute('aria-expanded', 'true');
    await expect(workspace.getByTestId('build-log')).toContainText('=== 构建完成 skills.');
    // 构建后又保存了修改：标题与日志一致（上次构建完成），并说明要重新构建；页面上的状态相同
    await expect(workspace.getByTestId('build-log-status')).toHaveText(
      /构建完成；之后内容有修改，需要重新构建$/,
    );
    await expect(page.getByTestId('build-status')).toHaveText('需要重新构建');
    await expect.poll(() => height(page, 'skill-editor')).toBeGreaterThan(size.height * 0.5);
    expect(await singleButtonRows(page)).toEqual([]);
    await page.screenshot({
      path: `${shots}/w46-fullscreen-log-${String(size.width)}.png`,
      animations: 'disabled',
    });
    // 面板自己的收起按钮
    await workspace.getByRole('button', { name: '收起构建日志' }).click();
    await expect(workspace.getByTestId('build-log-panel')).toHaveCount(0);
    await expect(logToggle).toHaveAttribute('aria-expanded', 'false');
  }

  // 按钮退出：回到页面布局
  await toggle.click();
  await expectFullscreen(false);
  await expect(page.getByTestId('variant-actions')).toBeVisible();
  expect(pageErrors).toEqual([]);
});

// 一份长的 Markdown：frontmatter、表格、代码、mermaid、指向同一 variant 中另一个文件的链接
function longMarkdown(stage: string, marker: string): string {
  const sections = Array.from(
    { length: 30 },
    (_, i) => `## 第 ${String(i + 1)} 节\n\n这一节的说明 ${String(i + 1)}。\n`,
  );
  return [
    '---',
    `name: ${stage}`,
    'description: 逐个文件扫描',
    '---',
    '',
    `# 扫描 ${marker}`,
    '',
    '| 输入 | 输出 |',
    '| --- | --- |',
    '| 文件 | 发现 |',
    '',
    '```ts',
    'const files = await list();',
    '```',
    '',
    '```mermaid',
    'flowchart LR',
    '  A[列出] --> B[扫描]',
    '```',
    '',
    '见 [检查清单](checklist.md)。',
    '',
    ...sections,
    `最后一行 ${marker}`,
    '',
  ].join('\n');
}

test('variant 页面的 .md 文件：默认预览，编辑 / 预览 / 并排，并排时实时更新与滚动同步，全屏中同样可用；对比用共用的 diff', async ({
  page,
  request,
}) => {
  const { marker, stage, first } = await ownWorkflow(request);
  const derived = (await (
    await request.post(`${api}/variants/${first}/derive`, { data: { name: `W50 ${marker}` } })
  ).json()) as { id: string };
  const skill = `skills/${stage}/SKILL.md`;
  const write = async (path: string, content: string) => {
    const response = await request.put(`${api}/variants/${derived.id}/file`, {
      data: { path, content },
    });
    expect(response.status()).toBe(200);
  };
  await write(skill, longMarkdown(stage, marker));
  await write(`skills/${stage}/checklist.md`, `# 检查清单 ${marker}\n\n- [ ] 每个文件都看过\n`);
  await write(`skills/${stage}/scan.sh`, 'echo scan\n');

  await page.setViewportSize(sizes[0]);
  await page.goto(`/variants/${derived.id}?file=${encodeURIComponent(skill)}`);
  const workspace = page.getByTestId('skill-workspace');
  const view = workspace.getByTestId('workspace-view');
  const fileView = workspace.getByTestId('file-view');
  const preview = workspace.getByTestId('md-preview');
  const editor = workspace.getByTestId('skill-editor');
  const lines = editor.locator('.view-lines');

  // 默认预览：21.1 的渲染，编辑器隐藏
  await expect(view).toHaveAttribute('data-view', 'preview');
  // 编辑、预览、并排与对比是工具栏中的一组，"编辑"只出现一次
  await expect(view.getByRole('tab')).toHaveText(['编辑', '预览', '并排', '对比']);
  await expect(
    workspace.getByTestId('workspace-toolbar').getByText('编辑', { exact: true }),
  ).toHaveCount(1);
  await expect(fileView).toHaveAttribute('data-view', 'preview');
  await expect(editor).toBeHidden();
  const article = preview.getByTestId('markdown');
  await expect(article.getByRole('heading', { level: 1 })).toHaveText(`扫描 ${marker}`);
  await expect(article.locator('table.frontmatter th')).toHaveText(['name', 'description']);
  await expect(article.locator('pre code.hljs.language-ts .hljs-keyword').first()).toHaveText(
    'const',
  );
  await expect(article.getByTestId('mermaid').locator('svg')).toBeVisible();
  for (const size of sizes) {
    await page.setViewportSize(size);
    expect(await height(page, 'md-preview')).toBeGreaterThan(size.height * 0.6);
    expect(await singleButtonRows(page)).toEqual([]);
    expect(await horizontalScroll(page)).toBe(false);
    await page.screenshot({
      path: `${shots}/w50b-variant-preview-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }

  // 并排：左编辑、右预览，编辑时预览实时更新，未保存
  await view.getByRole('tab', { name: '并排' }).click();
  await expect(fileView).toHaveAttribute('data-view', 'split');
  await expect(editor).toBeVisible();
  await expect(lines).toContainText(`扫描 ${marker}`);
  const editorBox = await editor.boundingBox();
  const previewBox = await preview.boundingBox();
  if (editorBox === null || previewBox === null) throw new Error('并排的两侧不可见');
  expect(editorBox.x + editorBox.width).toBeLessThanOrEqual(previewBox.x + 1);
  expect(Math.abs(editorBox.width - previewBox.width)).toBeLessThan(4);
  // 在一级标题之后加一段（macOS 上 Meta 组合键到不了 Monaco，用鼠标放光标、End 到行末）
  await lines.getByText(`# 扫描 ${marker}`).click();
  await page.keyboard.press('End');
  await page.keyboard.type(`\n\n新加的一段 ${marker}`);
  await expect(article.locator('h1 + p')).toHaveText(`新加的一段 ${marker}`);
  await expect(workspace.getByTestId('save-state')).toHaveText('未保存');

  // 滚动同步：编辑器向下翻页，预览跟着向下；翻回顶，预览回顶；预览滚到底，编辑器跟到最后一行
  const previewTop = () => preview.evaluate((el) => el.scrollTop);
  for (let i = 0; i < 3; i += 1) await page.keyboard.press('PageDown');
  await expect.poll(previewTop).toBeGreaterThan(0);
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('PageUp');
  await expect.poll(previewTop).toBe(0);
  await page.waitForTimeout(150);
  await preview.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(lines).toContainText(`最后一行 ${marker}`);
  await expect(lines.getByText(`# 扫描 ${marker}`)).toHaveCount(0);
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.screenshot({
      path: `${shots}/w50b-variant-split-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }

  // 选择记在浏览器中：刷新后仍是并排；未保存的修改先保存
  await workspace.getByRole('button', { name: '保存', exact: true }).click();
  await expect(workspace.getByTestId('save-state')).toHaveText('已保存');
  await page.reload();
  await expect(fileView).toHaveAttribute('data-view', 'split');
  await expect(article).toContainText(`新加的一段 ${marker}`);

  // 全屏中同样可用：切到预览，铺满窗口
  await workspace.getByTestId('fullscreen-toggle').click();
  await expect(workspace).toHaveAttribute('data-fullscreen', 'true');
  await view.getByRole('tab', { name: '预览' }).click();
  await expect(editor).toBeHidden();
  await expect(article.getByRole('heading', { level: 1 })).toHaveText(`扫描 ${marker}`);
  for (const size of sizes) {
    await page.setViewportSize(size);
    expect(await height(page, 'md-preview')).toBeGreaterThan(size.height * 0.85);
    expect(await singleButtonRows(page)).toEqual([]);
    await page.screenshot({
      path: `${shots}/w50b-variant-fullscreen-preview-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }
  await view.getByRole('tab', { name: '并排' }).click();
  await expect(editor).toBeVisible();
  await expect(preview).toBeVisible();
  await page.screenshot({
    path: `${shots}/w50-variant-fullscreen-split.png`,
    animations: 'disabled',
  });
  await view.getByRole('tab', { name: '预览' }).click();

  // 预览中指向另一个 .md 的链接在工作区中打开它
  await article.getByRole('link', { name: '检查清单' }).click();
  await expect(workspace.getByTestId('current-file')).toHaveText(`skills/${stage}/checklist.md`);
  await expect(article.getByRole('heading', { level: 1 })).toHaveText(`检查清单 ${marker}`);

  // 其他类型的文件只有编辑
  await page.goto(`/variants/${derived.id}?file=${encodeURIComponent(`skills/${stage}/scan.sh`)}`);
  await expect(lines).toContainText('echo scan');
  await expect(view.getByRole('tab')).toHaveText(['编辑', '对比']);
  await expect(view).toHaveAttribute('data-view', 'edit');
  await expect(preview).toHaveCount(0);

  // 对比：与来源对比，共用的 diff（红绿、行号、统一与并排），每个文件一个可折叠的标题
  await workspace.getByRole('tab', { name: '对比' }).click();
  const diff = workspace.getByTestId('skill-diff');
  const files = diff.getByTestId('diff-file');
  await expect(files).toHaveCount(3);
  const card = diff.locator(`[data-path="${skill}"]`);
  await expect(
    card.locator('td.diff-code-insert').filter({ hasText: `新加的一段 ${marker}` }),
  ).toBeVisible();
  await expect(card.locator('td.diff-code-delete').first()).toHaveCSS(
    'background-color',
    'rgb(255, 235, 233)',
  );
  await expect(diff.locator(`[data-path="skills/${stage}/scan.sh"]`)).toContainText('新增');
  const typeToggle = workspace.getByTestId('diff-view-type');
  for (const type of ['unified', 'split'] as const) {
    await typeToggle.getByRole('button', { name: type === 'unified' ? '统一' : '并排' }).click();
    await expect(diff.locator(`table.diff-${type}`).first()).toBeVisible();
    for (const size of sizes) {
      await page.setViewportSize(size);
      expect(await singleButtonRows(page)).toEqual([]);
      await page.screenshot({
        path: `${shots}/w50-variant-diff-${type}-${String(size.width)}.png`,
        animations: 'disabled',
      });
    }
  }
  await typeToggle.getByRole('button', { name: '统一' }).click();
  // 点左侧的文件滚动到它；文件标题可以收起
  await workspace
    .getByRole('navigation', { name: '改过的文件' })
    .getByRole('button', { name: new RegExp(`skills/${stage}/scan\\.sh`) })
    .click();
  await card.getByRole('button', { name: skill }).click();
  await expect(card.locator('table')).toHaveCount(0);

  // 对比也记在浏览器中：刷新后仍是对比，全屏中同一组
  await page.reload();
  await expect(view).toHaveAttribute('data-view', 'diff');
  await expect(diff.getByTestId('diff-file')).toHaveCount(3);
  await workspace.getByTestId('fullscreen-toggle').click();
  await expect(workspace).toHaveAttribute('data-fullscreen', 'true');
  for (const size of sizes) {
    await page.setViewportSize(size);
    expect(await singleButtonRows(page)).toEqual([]);
    await page.screenshot({
      path: `${shots}/w50b-fullscreen-diff-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }
  await view.getByRole('tab', { name: '编辑' }).click();
  await expect(view).toHaveAttribute('data-view', 'edit');
  await expect(lines).toContainText('echo scan');
});
