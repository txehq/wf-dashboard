import path from 'node:path';
import { type APIRequestContext, expect, type Page } from './test.js';
import { runsProjectsDir } from './services.js';
import { runsServerPort } from '../ports.js';

// 详情页 e2e（details-*.spec.ts，project runs）共用的数据与检查。数据目录与 runs.spec.ts 相同：
// W4 端到端导入的真实 run，它们的 session 在导入时已划分阶段；对话区的用例另外导入服务端本机配置中的
// f0aca373（prepare-runs-e2e 放入），用它的对话区（含 AskUserQuestion）
export const api = `http://127.0.0.1:${String(runsServerPort)}/api`;
export const f0 = 'f0aca373-863f-4d62-babd-f48055092328';
export const lfgRun = 'r-20261009-dqva52';
export const icRuns = ['r-20261009-a26chw', 'r-20261009-27yz3d'];
export const shots = '.work/screenshots';
const source = path.join(runsProjectsDir, '-Users-linhaoz-Project-txe-txe-workflow');

export interface StageView {
  stage: string;
  status: string;
  startSeq: number | null;
  endSeq: number | null;
}

export const sessionOf = async (request: APIRequestContext, run: string) =>
  ((await (await request.get(`${api}/runs/${run}`)).json()) as { sessionId: string }).sessionId;

// lfg run 与第一个 ic run 的 session
export async function runSessions(request: APIRequestContext) {
  return {
    lfgSession: await sessionOf(request, lfgRun),
    icSession: await sessionOf(request, icRuns[0] ?? ''),
  };
}

// 导入服务端本机配置中 txe-workflow 项目的 f0aca373（已导入时接着增量导入，不重复）
export async function importTxeWorkflowSession(request: APIRequestContext) {
  const put = await request.post(`${api}/session-import`, {
    data: { files: [`${source}/${f0}.jsonl`] },
  });
  expect(put.ok()).toBe(true);
}

// 页面级横向滚动：没有时为空；有时列出伸出窗口右边的最深的几个元素与宽度，失败时就是报错中的 Received
const pageOverflow = (page: Page) =>
  page.evaluate(() => {
    const root = document.documentElement;
    if (root.scrollWidth <= root.clientWidth) return [];
    return [...document.querySelectorAll('body *')]
      .filter((el) => el.getBoundingClientRect().right > root.clientWidth + 0.5)
      .slice(-5)
      .map((el) => {
        const r = el.getBoundingClientRect();
        return `<${el.tagName.toLowerCase()} class="${String(el.getAttribute('class'))}" data-testid="${String(el.getAttribute('data-testid'))}"> right=${String(r.right)}`;
      })
      .concat([`clientWidth=${String(root.clientWidth)} scrollWidth=${String(root.scrollWidth)}`]);
  });

const expectNoPageScroll = (page: Page, message: string) =>
  expect.poll(() => pageOverflow(page), { message }).toEqual([]);

// 加载、点开一个已完成的阶段、展开前几个 tool 调用，每一步都检查页面级横向滚动
export async function checkWidth(page: Page, url: string) {
  await page.goto(url);
  await expect(page.getByTestId('timeline').first()).toBeVisible({ timeout: 60_000 });
  await expectNoPageScroll(page, `${url} 加载后`);
  const stage = page.locator('[data-testid^="stage-"][data-status="done"]').first();
  await stage.click();
  await expect(page.getByTestId('stage-requests')).toBeVisible();
  await expectNoPageScroll(page, `${url} 点开阶段后`);
  const tools = page.getByTestId('tool-call').locator('> button');
  const n = Math.min(await tools.count(), 8);
  // 从下往上展开：展开的内容只把下面的行推出虚拟滚动的渲染范围，不影响上面还没展开的行
  for (let i = n - 1; i >= 0; i--) await tools.nth(i).click();
  await expectNoPageScroll(page, `${url} 展开 tool 调用后`);
}

export const widths = [1280, 1440, 1920] as const;

// 请求明细中已渲染的主 session 行的 seq（虚拟滚动：timeline > 高度容器 > 行容器 > 行；子代理的嵌套行不算）
export async function visibleSeqs(page: Page): Promise<number[]> {
  const texts = await page
    .locator('[data-testid="timeline"] > div > div > [data-testid="request-row"]')
    .locator('header > span:first-child')
    .allTextContents();
  return texts.map((t) => Number(t.replace('#', '')));
}
