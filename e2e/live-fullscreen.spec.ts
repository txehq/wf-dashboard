import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { z } from 'zod';
import { liveFullscreenProjectsDir } from './services.js';

// Live 的全屏（Contracts 20.1、20.3）与工具栏（20.4）。服务端的 Claude Code 是替身命令
// （server/test/fixtures/live/claude-stand-in.mjs）：启动与每次 SIGWINCH 时写出 `size <列>x<行>`，
// 把收到的输入写成 `key "<JSON>"`。两个短 session 导入后以"本机配置"resume（HOME 在 .work/ 下），不调用 claude
const fixture = path.resolve(
  import.meta.dirname,
  '../server/test/fixtures/live/cfa31f10-e280-4908-bcf7-cbe9b00fbe53.jsonl',
);
const source = path.join(liveFullscreenProjectsDir, '-w47-fullscreen');
const sessions = [randomUUID(), randomUUID()];
const shots = '.work/screenshots';

function copySession(sessionId: string) {
  const lines = fs
    .readFileSync(fixture, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const entry = z.looseObject({}).parse(JSON.parse(l));
      if ('sessionId' in entry) entry.sessionId = sessionId;
      return JSON.stringify(entry);
    });
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, `${sessionId}.jsonl`), `${lines.join('\n')}\n`);
}

const Item = z.object({ id: z.string() });
const items: string[] = [];

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  for (const id of sessions) copySession(id);
  expect((await request.put('/api/sources', { data: { paths: [source] } })).status()).toBe(200);
  const imported = await request.post('/api/live/import', { data: { sessionIds: sessions } });
  expect(imported.status()).toBe(201);
  for (const item of z.array(Item).parse(await imported.json())) items.push(item.id);
  for (const sessionId of sessions) {
    const resumed = await request.post('/api/live/resume', {
      data: { sessionId, variantId: null, driver: 'human' },
    });
    expect(resumed.status()).toBe(201);
  }
});

test.afterAll(async ({ request }) => {
  for (const id of items) await request.post(`/api/live/${id}/stop`);
});

// 终端每一行的文字（xterm.js 的 DOM 渲染用不换行空格）
async function terminalLines(page: Page): Promise<string[]> {
  return page
    .locator('.xterm-rows > div')
    .evaluateAll((rows) => rows.map((r) => r.textContent.replaceAll(' ', ' ')));
}

// 替身最近一次读到的终端尺寸
async function lastSize(page: Page): Promise<{ cols: number; rows: number }> {
  const sizes = (await terminalLines(page)).flatMap((l) => {
    const m = /size (\d+)x(\d+)/.exec(l);
    return m === null ? [] : [{ cols: Number(m[1]), rows: Number(m[2]) }];
  });
  const last = sizes.at(-1);
  if (last === undefined) throw new Error('终端中没有替身写出的尺寸');
  return last;
}

// 等替身写出新的尺寸（与 before 不同）
async function sizeChanged(page: Page, before: { cols: number; rows: number }) {
  await expect
    .poll(async () => {
      const now = await lastSize(page);
      return now.cols !== before.cols || now.rows !== before.rows;
    })
    .toBe(true);
  return lastSize(page);
}

// 打开页面后终端的尺寸稳定下来：替身写出的尺寸一秒内不再增加（容器高度随内容长高时行数会不断增加）
async function settledSize(page: Page) {
  await expect(page.getByTestId('live-terminal')).toHaveAttribute('data-connection', 'open');
  await expect.poll(() => terminalLines(page)).toContainEqual(expect.stringMatching(/size /));
  const count = async () => (await terminalLines(page)).filter((l) => l.startsWith('size ')).length;
  await expect
    .poll(async () => {
      const before = await count();
      await page.waitForTimeout(1000);
      return (await count()) === before;
    })
    .toBe(true);
  return lastSize(page);
}

// 没有只放一个按钮的行（Contracts 20.4）：每个看得见的按钮，同一高度上还有别的文字或控件
async function loneButtons(page: Page): Promise<string[]> {
  return page.locator('main').evaluate((main) => {
    const box = main.getBoundingClientRect();
    const lone: string[] = [];
    for (const button of main.querySelectorAll('button, [role="button"]')) {
      const r = button.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const y = r.top + r.height / 2;
      let company = false;
      for (let x = box.left + 2; x < box.right - 2 && !company; x += 6) {
        if (x >= r.left && x <= r.right) continue;
        for (const el of document.elementsFromPoint(x, y)) {
          if (el.contains(button) || button.contains(el)) continue;
          const text = el.textContent.trim();
          if (text !== '' || el.matches('button, select, input, svg')) {
            company = true;
            break;
          }
        }
      }
      if (!company) lone.push(button.textContent.trim() || button.outerHTML.slice(0, 80));
    }
    return lone;
  });
}

const panelOf = (page: Page) => page.getByTestId('live-panel');

for (const [width, height] of [
  [1280, 800],
  [1600, 1000],
] as const) {
  test(`${String(width)}×${String(height)}：工具栏在一行，没有只放一个按钮的行，终端占页面的大部分高度`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height });
    await page.goto(`/live?item=${items[0] ?? ''}`);
    await settledSize(page);
    const toolbar = page.getByTestId('live-toolbar');
    // 一行中的元素垂直居中，高度不同：比较中线
    const centers = await toolbar.locator(':scope > *').evaluateAll((els) =>
      els.map((e) => {
        const r = e.getBoundingClientRect();
        return r.top + r.height / 2;
      }),
    );
    await page.screenshot({ path: `${shots}/w47-live-${String(width)}.png` });
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(4);
    expect(await loneButtons(page)).toEqual([]);
    const terminal = await page.getByTestId('live-terminal').boundingBox();
    expect((terminal?.height ?? 0) / height).toBeGreaterThan(0.55);
  });
}

test('全屏：终端铺满窗口并获得焦点，PTY 收到新尺寸；Esc 写进终端不退出；刷新后保持；⌃⇧F 退出', async ({
  page,
}) => {
  await page.goto(`/live?item=${items[0] ?? ''}`);
  const normal = await settledSize(page);
  await page.getByTestId('fullscreen-toggle').click();
  await expect(page).toHaveURL(/fullscreen=1/);
  const area = page.getByTestId('live-fullscreen');
  await expect(area).toHaveAttribute('data-fullscreen', 'true');
  expect(await area.boundingBox()).toEqual({ x: 0, y: 0, width: 1600, height: 1000 });
  const full = await sizeChanged(page, normal);
  expect(full.cols).toBeGreaterThan(normal.cols);
  expect(full.rows).toBeGreaterThan(normal.rows);
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  // 工具栏保留，仍在一行
  await expect(page.getByTestId('driver-switch')).toBeVisible();
  await expect(page.getByTestId('toggle-side')).toBeVisible();
  await expect(page.getByTestId('finder-menu')).toBeVisible();

  // Esc 进入终端（Claude Code 用它打断），全屏不变
  await page.keyboard.press('Escape');
  await expect.poll(() => terminalLines(page)).toContainEqual('key "\\u001b"');
  await page.keyboard.type('hi');
  await expect.poll(() => terminalLines(page)).toContainEqual('key "i"');
  await expect(area).toHaveAttribute('data-fullscreen', 'true');
  await page.screenshot({ path: `${shots}/w47-fullscreen.png` });

  // 刷新后保持全屏，之前的输出回放出来
  await page.reload();
  await expect(page.getByTestId('live-fullscreen')).toHaveAttribute('data-fullscreen', 'true');
  await expect.poll(() => terminalLines(page)).toContainEqual('key "\\u001b"');

  // ⌃⇧F 退出：回到原来的布局，替身读到原来的尺寸
  const before = await lastSize(page);
  await page.keyboard.press('Control+Shift+KeyF');
  await expect(page.getByTestId('live-fullscreen')).toHaveAttribute('data-fullscreen', 'false');
  await expect(page).not.toHaveURL(/fullscreen=1/);
  expect(await sizeChanged(page, before)).toEqual(normal);
});

test('全屏中的阶段与请求：右侧抽屉，打开时终端变窄，拖动改变宽度，关上后终端恢复原宽度', async ({
  page,
}) => {
  await page.goto(`/live?item=${items[0] ?? ''}&fullscreen=1`);
  const full = await settledSize(page);
  const terminal = page.getByTestId('live-terminal');
  const wide = (await terminal.boundingBox())?.width ?? 0;
  const toolbarBefore = await page.getByTestId('live-toolbar').boundingBox();

  await page.getByTestId('toggle-side').click();
  const drawer = page.getByTestId('side-drawer');
  await expect(drawer).toBeVisible();
  const narrow = await sizeChanged(page, full);
  expect(narrow.cols).toBeLessThan(full.cols);
  expect(narrow.rows).toBe(full.rows);
  // 抽屉只占终端这一行，工具栏不动
  expect(await page.getByTestId('live-toolbar').boundingBox()).toEqual(toolbarBefore);
  const opened = (await drawer.boundingBox())?.width ?? 0;

  const handle = await page.getByTestId('side-drawer-handle').boundingBox();
  if (handle === null) throw new Error('没有拖动的把手');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 200);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 - 150, handle.y + 200, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => (await drawer.boundingBox())?.width ?? 0)
    .toBeGreaterThan(opened + 140);
  await sizeChanged(page, narrow);
  await page.screenshot({ path: `${shots}/w47-fullscreen-drawer.png` });

  await drawer.getByRole('button', { name: '关闭' }).click();
  await expect(drawer).toHaveCount(0);
  await expect.poll(async () => (await terminal.boundingBox())?.width ?? 0).toBe(wide);
  await expect.poll(() => lastSize(page)).toEqual(full);
});

test('全屏中切换交互项：⌃⇧] 与工具栏的下拉，切换后保持全屏', async ({ page }) => {
  const [first, second] = items;
  if (first === undefined || second === undefined) throw new Error('没有两个交互项');
  await page.goto(`/live?item=${first}&fullscreen=1`);
  await expect(panelOf(page)).toHaveAttribute('data-live', first);
  await expect(page.getByTestId('live-terminal')).toHaveAttribute('data-connection', 'open');

  await page.keyboard.press('Control+Shift+BracketRight');
  await expect(panelOf(page)).toHaveAttribute('data-live', second);
  await expect(page.getByTestId('live-fullscreen')).toHaveAttribute('data-fullscreen', 'true');
  await expect(page).toHaveURL(new RegExp(`item=${second}`));
  // 新的终端获得焦点，按键进入这一项的进程
  await expect(page.getByTestId('live-terminal')).toHaveAttribute('data-connection', 'open');
  await expect(page.locator('.xterm-helper-textarea')).toBeFocused();
  await page.keyboard.type('z');
  await expect.poll(() => terminalLines(page)).toContainEqual('key "z"');

  await page.getByTestId('live-switcher').selectOption(first);
  await expect(panelOf(page)).toHaveAttribute('data-live', first);
  await expect(page.getByTestId('live-fullscreen')).toHaveAttribute('data-fullscreen', 'true');
  await page.keyboard.press('Control+Shift+BracketLeft');
  await expect(panelOf(page)).toHaveAttribute('data-live', second);
});
