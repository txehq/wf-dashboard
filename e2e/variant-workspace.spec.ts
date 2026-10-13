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
// 文件树、对比的文件列表（nav）、标签与 Monaco 内部的按钮是列表项，不算
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
      .filter((b) => visible(b) && b.closest('nav, [role="tablist"], .monaco-editor') === null)
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
    // 编辑器占页面高度的大部分
    expect(await height(page, 'skill-editor')).toBeGreaterThan(size.height * 0.6);
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
  await expect(workspace.getByTestId('skill-diff').locator('.modified .view-lines')).toContainText(
    `W46${marker}abcQS`,
  );
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
