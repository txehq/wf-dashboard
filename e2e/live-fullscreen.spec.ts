import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page, test } from './test.js';
import { z } from 'zod';
import { checkContrast } from './contrast.js';
import { fixtureCwd } from './fixture-cwd.js';
import { liveFullscreenProjectsDir } from './services.js';
import { expectLastRowVisible } from './terminal-fit.js';

// Live 的全屏（Contracts 20.1、20.3）与工具栏（20.4）。服务端的 Claude Code 是替身命令
// （server/test/fixtures/live/claude-stand-in.mjs）：启动与每次 SIGWINCH 时写出 `size <列>x<行>`，
// 把收到的输入写成 `key "<JSON>"`，最后一行是状态行。两个短 session 导入后以"本机配置"resume（HOME 在 .work/ 下），不调用 claude
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
  const files = sessions.map((id) => path.join(source, `${id}.jsonl`));
  expect((await request.post('/api/session-import', { data: { files } })).status()).toBe(200);
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

// 替身收到的全部输入按顺序连起来：同一段时间内的按键可能作为一段到达 PTY（`key "hi"`），也可能分开到达
async function receivedInput(page: Page): Promise<string> {
  return (await terminalLines(page))
    .flatMap((l) => {
      const m = /^key (".*")$/.exec(l);
      return m?.[1] === undefined ? [] : [z.string().parse(JSON.parse(m[1]))];
    })
    .join('');
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

// 终端的最后一行完整可见（W80）：替身的最后一行是状态行，见 terminal-fit.ts
test('终端的最后一行：两种窗口、拖动改变窗口大小、全屏与退出、打开抽屉、工具栏折行', async ({
  page,
}) => {
  for (const [width, height] of [
    [1280, 800],
    [1600, 1000],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(`/live?item=${items[0] ?? ''}`);
    await expectLastRowVisible(page);
    await page.screenshot({ path: `${shots}/w80-live-${String(width)}.png` });
    // 拖动窗口的边缘：一步步变矮变窄，再恢复
    for (const step of [40, 120, 200]) {
      await page.setViewportSize({ width: width - step, height: height - step });
      await expectLastRowVisible(page);
    }
    await page.setViewportSize({ width, height });
    await expectLastRowVisible(page);

    await page.getByTestId('fullscreen-toggle').click();
    await expect(page.getByTestId('live-fullscreen')).toHaveAttribute('data-fullscreen', 'true');
    await expectLastRowVisible(page);
    await page.screenshot({ path: `${shots}/w80-live-fullscreen-${String(width)}.png` });
    await page.getByTestId('fullscreen-toggle').click();
    await expect(page.getByTestId('live-fullscreen')).toHaveAttribute('data-fullscreen', 'false');
    await expectLastRowVisible(page);

    await page.getByTestId('toggle-side').click();
    await expect(page.getByTestId('side-drawer')).toBeVisible();
    await expectLastRowVisible(page);
    await page.getByTestId('side-drawer').getByRole('button', { name: '关闭' }).click();
    await expect(page.getByTestId('side-drawer')).toHaveCount(0);
  }

  // 窗口窄到工具栏折成两行
  await page.setViewportSize({ width: 1100, height: 800 });
  await expect
    .poll(async () => (await page.getByTestId('live-toolbar').boundingBox())?.height ?? 0)
    .toBeGreaterThan(48);
  await expectLastRowVisible(page);
  await page.screenshot({ path: `${shots}/w80-live-toolbar-wrapped.png` });
});

test('终端的最后一行：切换交互的标签页与浏览器的标签页再回来', async ({ page, context }) => {
  const [first, second] = items;
  if (first === undefined || second === undefined) throw new Error('没有两个交互项');
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/live?item=${first}`);
  await expectLastRowVisible(page);
  await page.locator(`[data-testid="live-list"] [data-live="${second}"]`).click();
  await expect(panelOf(page)).toHaveAttribute('data-live', second);
  await expectLastRowVisible(page);
  await page.locator(`[data-testid="live-tab"][data-live="${first}"]`).click();
  await expect(panelOf(page)).toHaveAttribute('data-live', first);
  await expectLastRowVisible(page);

  const other = await context.newPage();
  await other.goto('/sessions');
  await page.bringToFront();
  await expectLastRowVisible(page);
  await other.close();
});

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
  await expect.poll(() => receivedInput(page)).toBe('\u001b');
  await page.keyboard.type('hi');
  await expect.poll(() => receivedInput(page)).toBe('\u001bhi');
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

test('对比度：运行中的交互项、全屏与打开的抽屉（阶段与请求）达到 WCAG AA，明暗两种主题', async ({
  page,
}) => {
  await page.goto(`/live?item=${items[0] ?? ''}`);
  await expect(page.getByTestId('live-terminal')).toHaveAttribute('data-connection', 'open');
  await checkContrast(page, 'live-item', { screenshot: true });

  await page.getByTestId('fullscreen-toggle').click();
  await expect(page.getByTestId('live-fullscreen')).toHaveAttribute('data-fullscreen', 'true');
  await page.getByTestId('toggle-side').click();
  await expect(page.getByTestId('side-drawer')).toBeVisible();
  await checkContrast(page, 'live-fullscreen-drawer', { screenshot: true });
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

  await page.getByTestId('live-switcher').click();
  await page.locator(`[data-testid="live-switcher-item"][data-live="${first}"]`).click();
  await expect(panelOf(page)).toHaveAttribute('data-live', first);
  await expect(page.getByTestId('live-fullscreen')).toHaveAttribute('data-fullscreen', 'true');
  await page.keyboard.press('Control+Shift+BracketLeft');
  await expect(panelOf(page)).toHaveAttribute('data-live', second);
});

// Contracts 25.1（W74）：任何 session 都可以清除。运行中的交互进程用到的 session 在第三列中照常可以取消勾选，
// 应用后不在管理表格中，进程照常运行；之后从上面重新勾选导入
test('Sessions 的第三列：运行中的交互进程用到的 session 可以清除，进程照常运行', async ({
  page,
  request,
}) => {
  const [id] = sessions;
  const [item] = items;
  if (id === undefined || item === undefined) throw new Error('没有交互项');
  await page.goto('/sessions');
  const panel = page.getByTestId('import-panel');
  await panel.locator(`[data-testid="import-project"][data-cwd="${fixtureCwd(fixture)}"]`).click();
  for (const s of sessions) {
    const disk = panel.locator(`[data-testid="disk-session"][data-session="${s}"]`);
    await expect(disk.getByTestId('disk-imported')).toHaveText('已导入');
    await expect(disk.getByRole('checkbox')).toBeChecked();
    await expect(disk.getByRole('checkbox')).toBeEnabled();
  }
  const row = panel.locator(`[data-testid="disk-session"][data-session="${id}"]`);
  await row.getByRole('checkbox').uncheck();
  await expect(row.getByTestId('disk-change')).toHaveText('− 清除');
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1600, height: 1000 },
  ]) {
    await page.setViewportSize(size);
    await page.screenshot({
      path: `${shots}/w74-sessions-clear-running-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }
  await panel.getByTestId('import-apply').click();
  const managed = page.locator(`[data-testid="session-row"][data-session="${id}"]`);
  await expect(managed).toHaveCount(0);
  await expect(row.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByRole('alert')).toHaveCount(0);
  const detail = z
    .object({ status: z.string() })
    .parse(await (await request.get(`/api/live/${item}`)).json());
  expect(detail.status).toBe('running');

  await row.getByRole('checkbox').check();
  await panel.getByTestId('import-apply').click();
  await expect(managed).toHaveCount(1);
});

// W84（W82 的 bug 3）：与 Claude Code 的 tui: fullscreen 一样，替身在备用屏幕中画，结束时离开备用屏幕、
// 在主屏幕上打印 resume 提示。进程结束后终端中仍是结束时的那一屏，刷新页面后从 pty.log 回放同样如此
test('结束进程后终端保留结束时的输出：结束之后与刷新之后', async ({ page, request }) => {
  const sessionId = randomUUID();
  copySession(sessionId);
  const file = path.join(source, `${sessionId}.jsonl`);
  expect((await request.post('/api/session-import', { data: { files: [file] } })).status()).toBe(
    200,
  );
  expect(
    (await request.post('/api/live/import', { data: { sessionIds: [sessionId] } })).status(),
  ).toBe(201);
  const resumed = await request.post('/api/live/resume', {
    data: { sessionId, variantId: null, driver: 'human' },
  });
  expect(resumed.status()).toBe(201);
  const { id } = Item.parse(await resumed.json());
  items.push(id);

  await page.goto(`/live?item=${id}`);
  await settledSize(page);
  await page.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('draft');
  await expect.poll(() => receivedInput(page)).toBe('draft');
  const shown = async () => {
    const lines = await terminalLines(page);
    return {
      standIn: lines.includes('Claude Code 替身（测试）'),
      input: lines.some((l) => l.startsWith('key ')),
      status: lines.some((l) => l.startsWith('底部状态行 ')),
    };
  };
  const whole = { standIn: true, input: true, status: true };
  expect(await shown()).toEqual(whole);

  await page.getByRole('button', { name: '结束进程' }).click();
  const terminal = page.getByTestId('live-terminal');
  await expect(terminal).toHaveAttribute('data-connection', 'exited');
  await expect.poll(shown).toEqual(whole);
  await expect(panelOf(page).getByTestId('live-status')).toHaveAttribute('data-status', 'exited');
  // 结束时的那一屏放在主屏幕中：窗口变小时上面的行进入回滚区，向上滚动仍在
  await page.screenshot({ path: `${shots}/w84-live-exited-1600.png` });
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect.poll(async () => (await shown()).status).toBe(true);
  await page.screenshot({ path: `${shots}/w84-live-exited-1280.png` });
  await terminal.hover();
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, -400);
      return (await shown()).standIn;
    })
    .toBe(true);
  await page.screenshot({ path: `${shots}/w84-live-exited-1280-top.png` });
  await page.setViewportSize({ width: 1600, height: 1000 });

  await page.reload();
  await expect(terminal).toHaveAttribute('data-connection', 'exited');
  await expect.poll(shown).toEqual(whole);
  expect(await receivedInput(page)).toBe('draft');
});
