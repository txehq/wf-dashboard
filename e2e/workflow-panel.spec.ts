import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page, test } from './test.js';
import { checkContrast, setTheme, themes } from './contrast.js';
import { expectLastRowVisible } from './terminal-fit.js';
import { serverPort } from '../ports.js';

// 设计与优化会话的 workflow 面板（Contracts 第 26 节）：终端在左、面板在右，左侧列表与交互项一样不自动收起；工具栏与
// 交互项相同；流程图与文件树在
// 1 秒内跟随文件的变化、节点的标记、点节点打开 skill、对比、只看改动的、跟随 agent、拖动与收起、全屏。
// 测试代码直接写草稿目录中的文件代替 agent，服务端的 Codex 是替身命令（e2e/services.ts），不调用真实的 Codex 或 Claude Code
const api = `http://127.0.0.1:${String(serverPort)}/api`;
const marker = randomUUID().slice(0, 6);
const flowId = `panel-${marker}`;
// 使用手册的截图，复制进 vault 的 assets
const guideShots = '.work/guide/screenshots';
const sizes = [
  { width: 1280, height: 800 },
  { width: 1600, height: 1000 },
] as const;

test.setTimeout(180_000);
test.describe.configure({ mode: 'serial' });

let draftDir = '';
let liveId = '';
let baseName = '';
const skill = (file: string) => path.join(draftDir, 'src/skills', file);
const skillMd = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: ${name} 阶段\n---\n\n${body}\n`;

test.beforeAll(async ({ request }) => {
  const made = await request.post(`${api}/workflows`, {
    data: {
      id: flowId,
      name: `面板 ${marker}`,
      description: '',
      definition: {
        id: flowId,
        name: `面板 ${marker}`,
        stages: [{ id: 'scan' }, { id: 'report', repeatable: true }],
      },
    },
  });
  expect(made.status()).toBe(201);
  const variants = (await (await request.get(`${api}/variants`)).json()) as {
    id: string;
    name: string;
    workflowId: string;
  }[];
  const base = variants.find((v) => v.workflowId === flowId);
  if (base === undefined) throw new Error(`workflow ${flowId} 没有建出初稿`);
  baseName = base.name;
  const created = await request.post(`${api}/workflow-drafts`, {
    data: {
      mode: 'variant',
      engine: 'codex',
      workflowId: flowId,
      requirement: '改 scan',
      baseVariantId: base.id,
    },
  });
  expect(created.status()).toBe(201);
  const { draft } = (await created.json()) as { draft: { id: string; liveId: string } };
  liveId = draft.liveId;
  await expect
    .poll(
      async () =>
        ((await (await request.get(`${api}/live/${liveId}`)).json()) as { status: string }).status,
      { timeout: 60_000 },
    )
    .toBe('running');
  draftDir = (
    (await (await request.get(`${api}/workflow-drafts/${draft.id}`)).json()) as {
      dir: string;
    }
  ).dir;
});

test.afterAll(async ({ request }) => {
  const stopped = await request.post(`${api}/live/${liveId}/stop`);
  expect([200, 409]).toContain(stopped.status());
});

// expand：放不下终端与面板时面板默认收起（Contracts 26.1），需要面板的用例把它展开
async function openItem(page: Page, expand = true) {
  await page.goto(`/live?item=${liveId}`);
  const work = page.getByTestId('design-work');
  await expect(work).toBeVisible();
  if (!expand) return;
  if ((await work.getAttribute('data-panel')) === 'collapsed') {
    await page.getByTestId('ws-expand').click();
  }
  await expect(page.getByTestId('workflow-panel')).toBeVisible();
  await expect(page.getByTestId(`flow-node-${flowId}`)).toBeVisible();
}

const box = async (page: Page, testId: string) => {
  const found = await page.getByTestId(testId).boundingBox();
  if (found === null) throw new Error(`${testId} 不可见`);
  return found;
};

// 截图（报告与 User Guide 引用）
const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${guideShots}/w77-panel-${name}.png`, animations: 'disabled' });

// 终端这一行的宽度规则（Contracts 26.1）：终端先保证 560 px；收起的窄边 36 px，分隔条 8 px，抽屉前的间隔 12 px
const TERMINAL = 560;
const terminalKeeps560 = async (page: Page) => {
  await expect
    .poll(async () => (await box(page, 'design-terminal')).width, '终端不少于 560 px')
    .toBeGreaterThanOrEqual(TERMINAL);
};

test('布局：左侧列表不收起，终端先保证 560 px，面板与阶段与请求抽屉分剩下的宽度；工具栏与交互项相同', async ({
  page,
}) => {
  await page.goto('/live');
  await page.evaluate(() => {
    localStorage.clear();
  });
  for (const size of sizes) {
    await page.setViewportSize(size);
    // 每种窗口都看没有操作过时面板是否展开
    await page.evaluate(() => {
      localStorage.removeItem('wfd.workspace.panelCollapsed');
    });
    await openItem(page, false);
    // 打开设计的项时左侧列表与交互项一样保持展开
    await expect(page.getByTestId('live-aside')).toHaveAttribute('data-compact', 'false');
    const work = page.getByTestId('design-work');
    const row = await box(page, 'design-work');
    const spare = row.width - TERMINAL;
    const panelFits = spare >= 8 + 340;
    // 剩下的宽度放得下面板时展开，放不下时收成窄边
    await expect(work).toHaveAttribute('data-panel', panelFits ? 'open' : 'collapsed');
    await terminalKeeps560(page);
    if (panelFits) expect((await box(page, 'ws-panel')).width).toBeGreaterThanOrEqual(340);
    // 没有横向滚动
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(size.width);
    // 工具栏与交互项相同：状态、驾驶者（模拟用户不可选）、结束进程、model · effort、访达、阶段与请求，
    // 之后是保存与花费，全屏在右端；都在一行，下面没有只放按钮的一行
    const toolbar = page.getByTestId('live-toolbar');
    await expect(toolbar.getByTestId('live-status')).toHaveAttribute('data-status', 'running');
    const drivers = toolbar.getByTestId('driver-switch');
    await expect(drivers.getByRole('radio', { name: '人' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    const simulated = drivers.getByRole('radio', { name: '模拟用户' });
    await expect(simulated).toBeDisabled();
    await expect(simulated).toHaveAttribute('title', '设计与优化的会话只由人驾驶');
    await expect(toolbar.getByTestId('hand-back')).toHaveCount(0);
    await expect(toolbar.getByRole('button', { name: '结束进程' })).toBeVisible();
    await expect(toolbar.getByTestId('live-model')).toHaveText(/^\S+ · \S+$/);
    await expect(toolbar.getByTestId('toggle-side')).toBeVisible();
    await expect(toolbar.getByTestId('codex-draft-save')).toBeVisible();
    await expectLastRowVisible(page);
    await page.screenshot({
      path: `.work/screenshots/w88-design-${String(size.width)}.png`,
      animations: 'disabled',
    });
    const toolbarBox = await box(page, 'live-toolbar');
    const statusBox = await toolbar.getByTestId('live-status').boundingBox();
    if (statusBox === null) throw new Error('状态不可见');
    const saveBox = await box(page, 'codex-draft-save');
    const fullBox = await box(page, 'fullscreen-toggle');
    for (const b of [statusBox, saveBox]) {
      expect(Math.abs(b.y + b.height / 2 - (fullBox.y + fullBox.height / 2))).toBeLessThan(4);
    }
    expect(toolbarBox.height).toBeLessThan(44);
    // 下面一行：workflow、底子 variant、引擎与工作目录
    const meta = page.getByTestId('live-meta');
    await expect(meta.getByTestId('live-workflow-name')).toHaveText(`/${flowId}`);
    await expect(meta.getByTestId('live-variant-name')).toHaveText(baseName);
    await expect(meta.getByTestId('live-engine')).toHaveText('Codex');
    await expect(meta.getByTestId('live-cwd')).toHaveText(draftDir);

    // "阶段与请求"：抽屉与交互项相同，有请求明细；还没有阶段时按草稿的 workflow 说明。
    // - 终端 560 px 与面板窄边之外放得下 340 px 的抽屉时并排：终端仍不少于 560 px，抽屉不超过剩下的宽度；
    //   放不下面板与抽屉两者时面板收成窄边，关上抽屉后恢复
    // - 放不下时抽屉以 380 px 覆盖在终端右侧：终端不改变大小（PTY 的尺寸不变），面板照旧
    const drawerBeside = row.width - TERMINAL - 36 - 12 >= 340;
    const terminalBefore = await box(page, 'design-terminal');
    const sizeLine = () =>
      page
        .getByTestId('live-terminal')
        .evaluate((el) => el.querySelector('.xterm-rows > div:last-child')?.textContent ?? '');
    const sizeBefore = await sizeLine();
    await toolbar.getByTestId('toggle-side').click();
    const drawer = page.getByTestId('side-drawer');
    await expect(drawer.getByRole('heading', { name: '请求明细' })).toBeVisible();
    await expect(drawer.getByTestId('live-side-no-stage')).toHaveText(
      `还没有进入 /${flowId} 的阶段。`,
    );
    await expect(drawer).not.toContainText('/lfg');
    await expect(work).toHaveAttribute('data-drawer', drawerBeside ? 'beside' : 'overlay');
    const drawerBox = await box(page, 'side-drawer');
    if (drawerBeside) {
      const bothFit = spare - 12 >= 8 + 340 + 340;
      await expect(work).toHaveAttribute('data-panel', panelFits && bothFit ? 'open' : 'collapsed');
      await terminalKeeps560(page);
      expect(drawerBox.width).toBeGreaterThanOrEqual(340);
      expect(drawerBox.width).toBeLessThanOrEqual(
        spare - 12 - (panelFits && bothFit ? 8 + 340 : 36) + 1,
      );
    } else {
      await expect(work).toHaveAttribute('data-panel', panelFits ? 'open' : 'collapsed');
      expect(drawerBox.width).toBe(380);
      // 盖在终端右侧，贴着这一行的右边缘
      expect(drawerBox.x).toBeLessThan(terminalBefore.x + terminalBefore.width);
      expect(Math.abs(drawerBox.x + drawerBox.width - (row.x + row.width))).toBeLessThan(1);
      expect(await drawer.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none');
      // 等一帧以上再比较：终端不改变大小，PTY 的尺寸不变
      await page.waitForTimeout(500);
      expect(await box(page, 'design-terminal')).toEqual(terminalBefore);
      expect(await sizeLine()).toBe(sizeBefore);
    }
    await expectLastRowVisible(page);
    await page.screenshot({
      path: `.work/screenshots/w88-design-side-${String(size.width)}.png`,
      animations: 'disabled',
    });
    await drawer.getByRole('button', { name: '关闭' }).click();
    await expect(drawer).toHaveCount(0);
    await expect(work).toHaveAttribute('data-drawer', 'closed');
    await expect(work).toHaveAttribute('data-panel', panelFits ? 'open' : 'collapsed');
    expect(await box(page, 'design-terminal')).toEqual(terminalBefore);

    // 放不下时用户点开面板：面板按剩下的宽度给，终端仍不少于 560 px
    if (!panelFits) {
      await page.getByTestId('ws-expand').click();
      await expect(work).toHaveAttribute('data-panel', 'open');
      await terminalKeeps560(page);
      await page.getByTestId('ws-collapse').click();
      await expect(work).toHaveAttribute('data-panel', 'collapsed');
      // 收起交互列表后这一行放得下终端与面板（没有操作过面板时默认展开）
      await page.evaluate(() => {
        localStorage.removeItem('wfd.workspace.panelCollapsed');
      });
      await page.getByTestId('live-list-collapse').click();
      await openItem(page, false);
      await expect(work).toHaveAttribute('data-panel', 'open');
      await terminalKeeps560(page);
      expect((await box(page, 'ws-panel')).width).toBeGreaterThanOrEqual(340);
    }
    await expect(page.getByTestId(`flow-node-${flowId}`)).toBeVisible();
    // 整张流程图缩放到框内可见（宽度在下一帧量出）
    const flowFrame = page.getByTestId('ws-flow').getByTestId('stage-flow');
    for (const id of [flowId, 'scan', 'report']) {
      await expect
        .poll(async () => {
          const frame = await flowFrame.boundingBox();
          const node = await page.getByTestId(`flow-node-${id}`).boundingBox();
          if (frame === null || node === null) return false;
          return (
            node.x >= frame.x &&
            node.x + node.width <= frame.x + frame.width &&
            node.y >= frame.y &&
            node.y + node.height <= frame.y + frame.height
          );
        }, `节点 ${id} 在框内`)
        .toBe(true);
    }
    // 窄的内容区中 frontmatter 是纵向的「键：值」列表
    const content = page.getByTestId('ws-content');
    await expect(content.locator('dl.frontmatter')).toBeVisible();
    await expect(content.locator('table.frontmatter')).toHaveCount(0);
    for (const theme of themes) {
      await setTheme(page, theme);
      await shot(page, `${theme}-${String(size.width)}`);
    }
    await setTheme(page, 'light');
    if (!panelFits) {
      await page.getByTestId('live-list-expand').click();
      await expect(page.getByTestId('live-aside')).toHaveAttribute('data-compact', 'false');
    }
  }
  // 只有用户点"收起交互列表"时收成窄条：每项只有色带、用途与引擎，悬停显示名字；选择记住，点开恢复完整的列表
  await page.getByTestId('live-list-collapse').click();
  await expect(page.getByTestId('live-aside')).toHaveAttribute('data-compact', 'true');
  const item = page.locator(`[data-testid="live-compact-item"][data-live="${liveId}"]`);
  await expect(item).toHaveAttribute('aria-current', 'true');
  await expect(item.getByTestId('live-engine-logo')).toHaveAttribute('data-engine', 'codex');
  await page.reload();
  await expect(page.getByTestId('live-aside')).toHaveAttribute('data-compact', 'true');
  await page.getByTestId('live-list-expand').click();
  await expect(page.getByTestId('live-aside')).toHaveAttribute('data-compact', 'false');
  await checkContrast(page, 'w77-workflow-panel', { include: '[data-testid="ws-panel"]' });
});

// 终端的最后一行完整可见（W80）：Codex 替身的最后一行是状态行，见 terminal-fit.ts
test('终端的最后一行：两种窗口，面板收起与展开，左侧列表展开与收起，全屏', async ({ page }) => {
  await page.goto('/live');
  await page.evaluate(() => {
    localStorage.clear();
  });
  for (const size of sizes) {
    await page.setViewportSize(size);
    await openItem(page);
    await expectLastRowVisible(page);
    await page.screenshot({
      path: `.work/screenshots/w80-design-${String(size.width)}.png`,
      animations: 'disabled',
    });
    await page.getByTestId('ws-collapse').click();
    await expect(page.getByTestId('design-work')).toHaveAttribute('data-panel', 'collapsed');
    await expectLastRowVisible(page);
    await page.getByTestId('ws-expand').click();
    await expect(page.getByTestId('workflow-panel')).toBeVisible();
    await expectLastRowVisible(page);
    await page.getByTestId('live-list-collapse').click();
    await expect(page.getByTestId('live-aside')).toHaveAttribute('data-compact', 'true');
    await expectLastRowVisible(page);
    await page.getByTestId('live-list-expand').click();
    await expect(page.getByTestId('live-aside')).toHaveAttribute('data-compact', 'false');
    await expectLastRowVisible(page);
    await page.getByTestId('fullscreen-toggle').click();
    await expect(page.getByTestId('live-fullscreen')).toHaveAttribute('data-fullscreen', 'true');
    await expectLastRowVisible(page);
    await page.getByTestId('fullscreen-toggle').click();
    await expect(page.getByTestId('live-fullscreen')).toHaveAttribute('data-fullscreen', 'false');
    await expectLastRowVisible(page);
  }
});

test('流程图与文件树在 1 秒内跟随改动；点节点打开 skill；改动原地更新并高亮；对比', async ({
  page,
}) => {
  await openItem(page);
  const flow = page.getByTestId('ws-flow');
  for (const id of [flowId, 'scan', 'report']) {
    await expect(flow.getByTestId(`flow-node-${id}`)).toHaveAttribute('data-mark', 'unchanged');
  }
  await expect(flow.getByTestId('flow-node-mark')).toHaveCount(0);
  // 默认打开入口 skill，Markdown 渲染
  const content = page.getByTestId('ws-content');
  await expect(content).toHaveAttribute('data-path', `skills/${flowId}/SKILL.md`);
  await expect(content.getByTestId('markdown')).toBeVisible();

  // 点节点打开这个阶段的 skill。第一次读取这个文件的回答晚 600 ms 到达（机器忙时的顺序）：页面先显示"加载中…"，
  // 原来的内容显示出来之前就改文件的话，页面拿到的第一份内容已是改后的，没有可比较的上一份，不高亮
  let held = false;
  await page.route(/workspace\/file\?path=skills%2Fscan%2FSKILL\.md/, async (route) => {
    if (held) return route.continue();
    held = true;
    await new Promise((resolve) => setTimeout(resolve, 600));
    return route.continue();
  });
  await flow.getByTestId('flow-node-scan').click();
  await expect(content).toHaveAttribute('data-path', 'skills/scan/SKILL.md');
  await expect(flow.getByTestId('flow-node-scan')).toHaveAttribute('aria-pressed', 'true');
  await expect(content).toContainText('在这里写这个阶段做什么。');

  // 每次渲染后记下标为改动的块：高亮只有 3 秒，忙时轮询可能赶不上，检查记下的集合
  await content.evaluate((element) => {
    const seen: string[][] = [];
    Object.assign(window, { wfdMarks: seen });
    new MutationObserver(() => {
      const marked = [...element.querySelectorAll('.md-mark-added')].map(
        (node) => `${node.tagName.toLowerCase()}.${node.className}: ${node.textContent}`,
      );
      if (marked.length > 0) seen.push(marked);
    }).observe(element, { subtree: true, childList: true, attributes: true });
  });

  // 改了打开着的文件：节点与文件树在 1 秒内标为修改，内容原地更新，改动的段落高亮
  fs.writeFileSync(skill('scan/SKILL.md'), skillMd('scan', `先列出要扫描的目录 ${marker}。`));
  await expect(flow.getByTestId('flow-node-scan')).toHaveAttribute('data-mark', 'modified', {
    timeout: 1_000,
  });
  const scanFile = page.locator('[data-testid="ws-file"][data-path="skills/scan/SKILL.md"]');
  await expect(scanFile).toHaveAttribute('data-status', 'modified', { timeout: 1_000 });
  await expect(content).toContainText(`先列出要扫描的目录 ${marker}。`, { timeout: 1_000 });
  // 改了的两处在同一次渲染中标出：frontmatter（description）与正文的段落
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { wfdMarks: string[][] }).wfdMarks[0]))
    .toEqual([
      'dl.frontmatter md-mark-added: namescandescriptionscan 阶段',
      `p.md-mark-added: 先列出要扫描的目录 ${marker}。`,
    ]);
  await shot(page, 'flash-1600');
  // 高亮是短暂的
  await expect(content.locator('.md-mark-added')).toHaveCount(0, { timeout: 5_000 });

  // 源码：语法高亮
  await content.getByTestId('ws-md-source').click();
  await expect(content.getByTestId('ws-code')).toContainText('name: scan');
  await content.getByTestId('ws-md-rendered').click();

  // 对比：相对底子的红绿 diff
  await content.getByTestId('ws-compare').click();
  const diff = content.getByTestId('ws-diff');
  await expect(diff.getByTestId('diff-view')).toBeVisible();
  await expect(diff.locator('.diff-code-insert').filter({ hasText: marker })).toHaveCount(1);
  await expect(diff.locator('.diff-code-delete').filter({ hasText: '在这里写' })).toHaveCount(1);
  await shot(page, 'compare-1600');
  await content.getByTestId('ws-compare').click();
  await expect(content.getByTestId('markdown')).toBeVisible();
});

test('workflow.yaml：加阶段后节点新增；解析失败时显示原文并保留已过期的图；skill 目录不存在的节点标红', async ({
  page,
}) => {
  await openItem(page);
  const flow = page.getByTestId('ws-flow');
  const yaml = path.join(draftDir, 'workflow.yaml');
  // variant 草稿中它是只读副本（0444）；这里代替设计新 workflow 时的 agent 改它
  fs.chmodSync(yaml, 0o644);
  const original = fs.readFileSync(yaml, 'utf8');
  fs.mkdirSync(skill('check'));
  fs.writeFileSync(skill('check/SKILL.md'), skillMd('check', '检查结果。'));
  fs.writeFileSync(yaml, `${original.trimEnd()}\n  - id: check\n`);
  await expect(flow.getByTestId('flow-node-check')).toHaveAttribute('data-mark', 'added', {
    timeout: 1_000,
  });

  fs.writeFileSync(yaml, 'id: [没有闭合\n');
  await expect(flow.getByTestId('ws-flow-error')).toContainText('workflow.yaml 不是合法的 YAML', {
    timeout: 1_000,
  });
  await expect(flow).toHaveAttribute('data-stale', 'true');
  await expect(flow.getByText('已过期')).toBeVisible();
  await expect(flow.getByTestId('flow-node-check')).toBeVisible();
  await shot(page, 'stale-1600');

  fs.writeFileSync(yaml, original);
  await expect(flow.getByTestId('ws-flow-error')).toHaveCount(0, { timeout: 1_000 });
  await expect(flow.getByTestId('flow-node-check')).toHaveCount(0);

  // 打开着的文件被删除：显示"已删除"；节点标红。先等文件读出来再删除
  await flow.getByTestId('flow-node-report').click();
  const content = page.getByTestId('ws-content');
  await expect(content).toHaveAttribute('data-path', 'skills/report/SKILL.md');
  await expect(content.getByTestId('markdown')).toBeVisible();
  fs.rmSync(skill('report'), { recursive: true });
  await expect(flow.getByTestId('flow-node-report')).toHaveAttribute('data-mark', 'missing', {
    timeout: 1_000,
  });
  await expect(page.getByTestId('ws-file-deleted')).toBeVisible({ timeout: 1_000 });
  const reportFile = page.locator('[data-testid="ws-file"][data-path="skills/report/SKILL.md"]');
  await expect(reportFile).toHaveAttribute('data-status', 'removed');
});

test('只看改动的；跟随 agent 时切到 agent 最近改的文件', async ({ page }) => {
  await openItem(page);
  const tree = page.getByTestId('ws-tree');
  // 入口未变；scan 修改、report 删除、check 新增（目录还在，只是不在 workflow.yaml 中）
  await expect(tree.getByTestId('ws-file')).toHaveCount(4);
  await page.getByTestId('ws-only-changed').check();
  await expect(tree.getByTestId('ws-file')).toHaveCount(3);
  await expect(tree.locator(`[data-path="skills/${flowId}/SKILL.md"]`)).toHaveCount(0);
  await page.getByTestId('ws-only-changed').uncheck();

  const content = page.getByTestId('ws-content');
  await expect(content).toHaveAttribute('data-path', `skills/${flowId}/SKILL.md`);
  // 默认不跟随：agent 改了别的文件，当前文件不变
  fs.writeFileSync(skill('scan/notes.md'), '# 笔记\n');
  await expect(tree.locator('[data-path="skills/scan/notes.md"]')).toHaveAttribute(
    'data-status',
    'added',
    { timeout: 1_000 },
  );
  await expect(content).toHaveAttribute('data-path', `skills/${flowId}/SKILL.md`);
  await page.getByTestId('ws-follow').check();
  fs.appendFileSync(skill('check/SKILL.md'), '\n再检查一遍。\n');
  await expect(content).toHaveAttribute('data-path', 'skills/check/SKILL.md', { timeout: 1_000 });
});

test('拖动分隔条改变面板宽度并记住；收起成窄边再展开；全屏时终端与面板都在全屏中', async ({
  page,
}) => {
  await openItem(page);
  // 收起交互列表，给拖动留出宽度
  await page.getByTestId('live-list-collapse').click();
  await expect(page.getByTestId('live-aside')).toHaveAttribute('data-compact', 'true');
  // 列表收起后这一行在下一帧才按新的宽度重排（面板默认占这一行的 40%）：重排之后再按分隔条的位置拖动
  await expect
    .poll(async () => {
      const panel = await box(page, 'ws-panel');
      const work = await box(page, 'design-work');
      return Math.abs(panel.width - 0.4 * work.width);
    })
    .toBeLessThan(2);
  const before = await box(page, 'ws-panel');
  const handle = await box(page, 'ws-panel-splitter');
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x - 120, handle.y + handle.height / 2, { steps: 6 });
  await page.mouse.up();
  const dragged = await box(page, 'ws-panel');
  expect(dragged.width).toBeGreaterThan(before.width + 100);
  expect((await box(page, 'design-terminal')).width).toBeGreaterThanOrEqual(560);
  await page.reload();
  await expect(page.getByTestId('workflow-panel')).toBeVisible();
  expect(Math.abs((await box(page, 'ws-panel')).width - dragged.width)).toBeLessThan(2);

  // 上下两部分之间的分隔同样可以拖动
  const flowBefore = await box(page, 'ws-flow');
  const rowHandle = await box(page, 'ws-flow-splitter');
  await page.mouse.move(rowHandle.x + rowHandle.width / 2, rowHandle.y + rowHandle.height / 2);
  await page.mouse.down();
  await page.mouse.move(rowHandle.x + rowHandle.width / 2, rowHandle.y + 80, { steps: 4 });
  await page.mouse.up();
  expect((await box(page, 'ws-flow')).height).toBeGreaterThan(flowBefore.height + 60);

  await page.getByTestId('ws-collapse').click();
  await expect(page.getByTestId('design-work')).toHaveAttribute('data-panel', 'collapsed');
  await expect(page.getByTestId('workflow-panel')).toHaveCount(0);
  await page.getByTestId('ws-expand').click();
  await expect(page.getByTestId('workflow-panel')).toBeVisible();

  await page.getByTestId('fullscreen-toggle').click();
  const area = page.getByTestId('live-fullscreen');
  await expect(area).toHaveAttribute('data-fullscreen', 'true');
  await expect(area.getByTestId('design-terminal')).toBeVisible();
  await expect(area.getByTestId('workflow-panel')).toBeVisible();
  const full = await box(page, 'design-work');
  expect(full.width).toBeGreaterThan(1500);
  await shot(page, 'fullscreen-1600');
  await page.setViewportSize(sizes[0]);
  await expect(area.getByTestId('workflow-panel')).toBeVisible();
  // 宽度在窗口变化后的下一帧重新计算
  await expect
    .poll(async () => (await box(page, 'design-terminal')).width)
    .toBeGreaterThanOrEqual(560);
  await shot(page, 'fullscreen-1280');
  await page.getByTestId('fullscreen-toggle').click();
  await expect(area).toHaveAttribute('data-fullscreen', 'false');
});
