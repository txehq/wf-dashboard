import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page, test } from './test.js';
import { serverPort } from '../ports.js';

// 设计会话的面板（Contracts 28.4）：5 个以上节点时整张流程图缩小到框内、节点文字不折行、没有 React Flow 的水印
// （Workflow 页面同样）；"对比"可以选上次保存与上一版。用空白新建的 workflow 草稿（没有底子），测试代码直接写草稿目录
// 中的文件代替 agent，服务端的 Codex 是替身命令（e2e/services.ts）
const api = `http://127.0.0.1:${String(serverPort)}/api`;
const marker = randomUUID().slice(0, 6);
const flowId = `weekly-${marker}`;
// W82 的 weekly-report：入口与 4 个小阶段共 5 个节点，revise 可以重复
const stages = ['collect', 'draft', 'revise', 'publish'];
const shots = '.work/screenshots';
// 使用手册的截图，复制进 vault 的 assets
const guideShots = '.work/guide/screenshots';

test.setTimeout(180_000);
test.describe.configure({ mode: 'serial' });

let draftId = '';
let draftDir = '';
let liveId = '';
const skillMd = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: ${name} 阶段\n---\n\n${body}\n`;
const writeSkill = (name: string, body: string) => {
  const dir = path.join(draftDir, 'src/skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), skillMd(name, body));
};

test.beforeAll(async ({ request }) => {
  const created = await request.post(`${api}/workflow-drafts`, {
    data: {
      mode: 'workflow',
      engine: 'codex',
      workflowId: flowId,
      name: `周报 ${marker}`,
      description: '',
      requirement: '写周报',
    },
  });
  expect(created.status()).toBe(201);
  const { draft } = (await created.json()) as { draft: { id: string; liveId: string } };
  draftId = draft.id;
  liveId = draft.liveId;
  await expect
    .poll(
      async () =>
        ((await (await request.get(`${api}/live/${liveId}`)).json()) as { status: string }).status,
      { timeout: 60_000 },
    )
    .toBe('running');
  draftDir = (
    (await (await request.get(`${api}/workflow-drafts/${draftId}`)).json()) as { dir: string }
  ).dir;
  // 代替 agent 写出入口与 5 个小阶段（revise 可以重复）
  fs.writeFileSync(
    path.join(draftDir, 'workflow.yaml'),
    [
      `id: ${flowId}`,
      `name: 周报 ${marker}`,
      'stages:',
      ...stages.flatMap((s) => [
        `  - id: ${s}`,
        ...(s === 'revise' ? ['    repeatable: true'] : []),
      ]),
      '',
    ].join('\n'),
  );
  for (const name of [flowId, ...stages]) writeSkill(name, `${name} 的第一稿。`);
  // 准备的中途若已停下 5 秒，骨架被记成了一份快照；去掉它，第一份快照就是上面写出的内容（文件刚改过，5 秒后才记）
  fs.rmSync(path.join(draftDir, '.dashboard/workspace'), { recursive: true, force: true });
});

test.afterAll(async ({ request }) => {
  const stopped = await request.post(`${api}/live/${liveId}/stop`);
  expect([200, 409]).toContain(stopped.status());
});

// 每个节点都在流程图的框内，文字没有超出节点（不折行、不截断）
async function expectFlowFits(page: Page, frame: ReturnType<Page['getByTestId']>, ids: string[]) {
  await expect(frame).toHaveAttribute('data-zoom', /.+/);
  for (const id of ids) {
    await expect
      .poll(async () => {
        const outer = await frame.boundingBox();
        const node = await frame.getByTestId(`flow-node-${id}`).boundingBox();
        if (outer === null || node === null) return false;
        return (
          node.x >= outer.x &&
          node.x + node.width <= outer.x + outer.width &&
          node.y >= outer.y &&
          node.y + node.height <= outer.y + outer.height
        );
      }, `节点 ${id} 在框内`)
      .toBe(true);
    // 节点的文字（第一个文本节点，角上的标记不算）只占一行，左右都在节点之内
    const fits = await frame.getByTestId(`flow-node-${id}`).evaluate((el) => {
      const text = [...el.childNodes].find((n) => n.nodeType === Node.TEXT_NODE);
      if (text === undefined) throw new Error('节点没有文字');
      const range = document.createRange();
      range.selectNodeContents(text);
      const lines = new Set([...range.getClientRects()].map((r) => Math.round(r.top)));
      const textBox = range.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return lines.size === 1 && textBox.left >= box.left && textBox.right <= box.right;
    });
    expect(fits, `节点 ${id} 的文字在一行内`).toBe(true);
  }
  // 没有横向滚动条：整张图都在框内
  expect(await frame.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(page.locator('.react-flow__attribution')).toHaveCount(0);
}

test('1280 与 1440 宽、5 个节点时整张流程图在面板的框内，入口文字不折行，没有水印', async ({
  page,
}) => {
  await page.goto('/live');
  await page.evaluate(() => {
    localStorage.clear();
  });
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
  ]) {
    await page.setViewportSize(size);
    await page.goto(`/live?item=${liveId}`);
    // 交互列表展开时 1280 宽在终端的 560 px 之外放不下面板，面板默认收成窄边（Contracts 26.1）：收起列表后
    // 面板展开，最窄的面板中整张图同样在框内
    const work = page.getByTestId('design-work');
    await expect(work).toBeVisible();
    if ((await work.getAttribute('data-panel')) === 'collapsed') {
      await page.getByTestId('live-list-collapse').click();
      await expect(work).toHaveAttribute('data-panel', 'open');
    }
    const flow = page.getByTestId('ws-flow').getByTestId('stage-flow');
    await expect(flow.getByTestId(`flow-node-${stages.at(-1) ?? ''}`)).toBeVisible();
    await expect(flow).toHaveAttribute('data-zoom', /.+/);
    await page.screenshot({
      path: `${shots}/w85-flow-${String(size.width)}.png`,
      animations: 'disabled',
    });
    await expectFlowFits(page, flow, [flowId, ...stages]);
  }
});

test('对比：没有底子时先没有可以对比的版本；改动后可选上一版；保存后可选上次保存', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto(`/live?item=${liveId}`);
  const flow = page.getByTestId('ws-flow');
  await flow.getByTestId('flow-node-collect').click();
  const content = page.getByTestId('ws-content');
  await expect(content).toHaveAttribute('data-path', 'skills/collect/SKILL.md');
  await content.getByTestId('ws-compare').click();
  const select = content.getByTestId('ws-against');
  // 准备好之后还没有改动过，没有底子、上次保存与上一版
  await expect(content.getByTestId('ws-diff-none')).toHaveText('还没有可以对比的版本。');
  await expect(select).toHaveCount(0);

  // 停下 5 秒后记下第一份快照；之后代替 agent 改 collect：上一版是改之前的那份
  const snapshots = path.join(draftDir, '.dashboard/workspace/snapshots');
  const recorded = () =>
    fs.existsSync(snapshots) ? fs.readdirSync(snapshots).filter((n) => /^\d+$/.test(n)).length : 0;
  await expect.poll(recorded, { timeout: 15_000 }).toBe(1);
  writeSkill('collect', `第一轮：读本周合并的 PR ${marker}。`);
  await expect(select).toHaveValue('previous', { timeout: 2_000 });
  await expect(select.locator('option')).toHaveText([/^上一版 \d\d:\d\d$/]);
  const diff = content.getByTestId('ws-diff');
  await expect(diff).toHaveAttribute('data-against', 'previous');
  await expect(diff.locator('.diff-code-insert').filter({ hasText: marker })).toHaveCount(1);
  await expect(diff.locator('.diff-code-delete').filter({ hasText: '第一稿' })).toHaveCount(1);

  // 第二轮：等这一轮记下快照后再改，上一版是第一轮的内容
  await expect.poll(recorded, { timeout: 15_000 }).toBe(2);
  await expect(diff.locator('.diff-code-insert').filter({ hasText: marker })).toHaveCount(1);
  writeSkill('collect', `第二轮：读本周合并的 PR 与完成的工单 ${marker}。`);
  await expect(diff.locator('.diff-code-insert').filter({ hasText: '完成的工单' })).toHaveCount(1, {
    timeout: 2_000,
  });
  await expect(diff.locator('.diff-code-delete').filter({ hasText: '第一轮' })).toHaveCount(1);
  // 收起交互列表：1280 宽时这一行才放得下终端与面板
  await page.getByTestId('live-list-collapse').click();
  await expect(page.getByTestId('live-aside')).toHaveAttribute('data-compact', 'true');
  for (const width of [1280, 1600] as const) {
    await page.setViewportSize({ width, height: width === 1280 ? 800 : 1000 });
    // 窗口变化后的下一帧按新的宽度重新分配：面板默认占这一行的 40%，终端至少 560 px、面板至少 340 px
    await expect
      .poll(async () => {
        const row = await page.getByTestId('design-work').boundingBox();
        const panel = await page.getByTestId('ws-panel').boundingBox();
        if (row === null || panel === null) return false;
        const expected = Math.min(Math.max(340, row.width - 568), Math.max(340, row.width * 0.4));
        return Math.abs(panel.width - expected) < 2;
      })
      .toBe(true);
    // 之后的下一帧流程图按新的框宽重新缩放：整张图在框内，并且几乎占满框宽（缩放按 0.05 取整）
    const sf = page.getByTestId('ws-flow').getByTestId('stage-flow');
    await expect
      .poll(() =>
        sf.evaluate((el) => {
          const inner = el.firstElementChild;
          if (!(inner instanceof HTMLElement)) throw new Error('流程图没有内容');
          return inner.offsetWidth <= el.clientWidth && inner.offsetWidth >= el.clientWidth * 0.9;
        }),
      )
      .toBe(true);
    await page.screenshot({
      path: `${guideShots}/guide-w85-compare-${String(width)}.png`,
      animations: 'disabled',
    });
  }

  // 保存为新 workflow：之后可选上次保存，与工作目录相同；再改一次后显示这次的改动
  const saved = await request.post(`${api}/workflow-drafts/${draftId}/save`, {
    data: {
      workflow: { name: `周报 ${marker}`, description: '写周报' },
      target: { kind: 'new', name: '初稿', description: '第一版' },
    },
  });
  expect(saved.status(), await saved.text()).toBe(200);
  await page.reload();
  await flow.getByTestId('flow-node-collect').click();
  await expect(content).toHaveAttribute('data-path', 'skills/collect/SKILL.md');
  await expect(select.locator('option')).toHaveText([/^上次保存 \d\d:\d\d$/, /^上一版 \d\d:\d\d$/]);
  // 没有选过时用第一个可用的
  await expect(select).toHaveValue('saved');
  await expect(diff).toHaveAttribute('data-against', 'saved');
  await expect(diff).toContainText('与上次保存相同。');
  await select.selectOption('previous');
  await expect(diff).toHaveAttribute('data-against', 'previous');
  await expect(diff.locator('.diff-code-delete').filter({ hasText: '第一轮' })).toHaveCount(1);
  await select.selectOption('saved');
  await expect(diff).toContainText('与上次保存相同。');
  writeSkill('collect', `第三轮：按 Linear project 分组 ${marker}。`);
  await expect(diff.locator('.diff-code-insert').filter({ hasText: '第三轮' })).toHaveCount(1, {
    timeout: 2_000,
  });
  await expect(diff.locator('.diff-code-delete').filter({ hasText: '第二轮' })).toHaveCount(1);
  // 选择记在 localStorage
  await page.reload();
  await flow.getByTestId('flow-node-collect').click();
  await expect(select).toHaveValue('saved');
});

test('Workflow 页面：1280 宽、5 个节点时整张流程图在框内，没有水印', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto(`/workflows/${flowId}`);
  const flow = page.getByTestId('stage-flow');
  await expect(flow.getByTestId(`flow-node-${flowId}`)).toBeVisible();
  await expectFlowFits(page, flow, [flowId, ...stages]);
  await page.screenshot({ path: `${shots}/w85-workflow-page-1280.png`, animations: 'disabled' });
});
