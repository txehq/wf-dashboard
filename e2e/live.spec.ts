import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from '@playwright/test';
import type { LiveDetail } from '../server/src/live/views.js';
import { runsServerPort } from '../ports.js';

// 交互区（Contracts 14）：构建基线 variant，新建 /lfg 做一个计算器（isolated、人驾驶），在终端中输入；
// 切到模拟用户驾驶、按键接管、交还；关掉页面重开后输出仍在；Sessions 详情的 resume 对话框。
// 真实运行：在 txehq 建副本仓库、写 vault 的 Project Magi Eval/Features/<liveId>/
const api = `http://127.0.0.1:${String(runsServerPort)}/api`;
const marker = randomUUID().slice(0, 8);

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `.work/screenshots/w30-${name}.png`, animations: 'disabled' });

// xterm.js 的 DOM 渲染用不换行空格
const terminalText = async (page: Page) =>
  ((await page.locator('.xterm-rows').textContent()) ?? '').replaceAll(' ', ' ');

test.describe.configure({ mode: 'serial' });

test('交互：新建、终端输入、驾驶者切换与交还、重开页面、resume 对话框', async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(3_600_000);
  const variantName = `W30 e2e ${marker}`;
  const created = await request.post(`${api}/variants`, {
    data: { name: variantName, model: 'opus', effort: 'high' },
  });
  expect(created.ok()).toBe(true);
  const variant = (await created.json()) as { id: string };
  const built = await request.post(`${api}/variants/${variant.id}/build`, { timeout: 900_000 });
  expect(built.ok()).toBe(true);
  const detail = async (id: string) =>
    (await (await request.get(`${api}/live/${id}`)).json()) as LiveDetail;

  await page.goto('/live');
  await page.getByTestId('new-live-toggle').click();
  const form = page.getByTestId('new-live');
  await form.getByTestId('live-variant').selectOption({ label: `${variantName}（opus · high）` });
  await form.getByRole('textbox', { name: '想法' }).fill('做一个计算器');
  await expect(form.getByTestId('save-as-task')).toHaveAttribute(
    'href',
    '/tasks/new?mode=lfg&input=%E5%81%9A%E4%B8%80%E4%B8%AA%E8%AE%A1%E7%AE%97%E5%99%A8',
  );
  // real 环境的提示：会在真实目录、仓库与工单上写入
  await form.getByText('real：在你填的真实目录中运行').click();
  await expect(form.getByTestId('real-warning')).toContainText(
    '会在真实目录、真实仓库与真实工单上写入',
  );
  await shot(page, 'new-form');
  await form.getByText('isolated：与评估 run 相同').click();
  await form.getByTestId('live-start').click();

  const panel = page.getByTestId('live-panel');
  await expect(panel).toBeVisible({ timeout: 300_000 });
  const id = (await panel.getAttribute('data-live')) ?? '';
  expect(id).toMatch(/^l-\d{8}-[a-z0-9]{6}$/);
  await expect(panel.getByTestId('live-variant-name')).toHaveText(variantName);
  await expect(panel.getByText(`txehq/wfe-${id}`)).toBeVisible();
  await expect.poll(() => terminalText(page), { timeout: 120_000 }).toContain('Claude Code');
  await expect.poll(() => terminalText(page), { timeout: 120_000 }).toContain('/lfg 做一个计算器');

  // interview 的第一次提问（Stop 或 AskUserQuestion）出现在终端中
  await expect
    .poll(async () => (await detail(id)).waiting !== null, { timeout: 900_000, intervals: [2000] })
    .toBe(true);
  await page.waitForTimeout(1500);
  await shot(page, 'interview-question');

  // 在终端中输入：文字出现在 Claude Code 的输入框
  const waiting = (await detail(id)).waiting;
  await page.getByTestId('live-terminal').click();
  if (waiting?.kind === 'text') {
    await page.keyboard.type('W30E2E');
    await expect.poll(() => terminalText(page)).toContain('W30E2E');
    for (const key of Array<string>('W30E2E'.length).fill('Backspace')) {
      await page.keyboard.press(key);
    }
    await expect.poll(() => terminalText(page)).not.toContain('W30E2E');
  } else {
    // 选项菜单：↓ 移动光标
    await page.keyboard.press('ArrowDown');
  }

  // 驾驶者切到模拟用户：Claude Code 正在等输入，模拟用户立即回答
  const switcher = panel.getByTestId('driver-switch');
  await switcher.getByRole('radio', { name: '模拟用户' }).click();
  await expect(switcher).toHaveAttribute('data-driver', 'simulated');
  await expect
    .poll(
      async () =>
        (await detail(id)).events.some(
          (e) => e.kind === 'simulated_reply' && e.payload.written === true,
        ),
      { timeout: 600_000, intervals: [2000] },
    )
    .toBe(true);
  await page.waitForTimeout(1500);
  await shot(page, 'simulated-driving');

  // 下一次等待输入时按一个键：驾驶者变为人
  await expect
    .poll(
      async () => {
        const d = await detail(id);
        return d.waiting !== null || d.driver === 'human';
      },
      { timeout: 900_000, intervals: [1000] },
    )
    .toBe(true);
  await page.getByTestId('live-terminal').click();
  await page.keyboard.press('ArrowDown');
  await expect(switcher).toHaveAttribute('data-driver', 'human', { timeout: 30_000 });
  await expect(panel.getByTestId('hand-back')).toBeEnabled();
  await shot(page, 'taken-over');
  const takeover = (await detail(id)).events.findLast((e) => e.kind === 'driver');
  expect(takeover?.payload.driver).toBe('human');

  // 交还给模拟用户
  await panel.getByTestId('hand-back').click();
  await expect(switcher).toHaveAttribute('data-driver', 'simulated');
  expect((await detail(id)).events.findLast((e) => e.kind === 'driver')?.payload).toEqual({
    driver: 'simulated',
    reason: 'release',
  });

  // 关掉页面重开：进程照常运行，终端先收到保留的输出
  const before = await terminalText(page);
  await page.close();
  expect((await detail(id)).status).toBe('running');
  const reopened = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  await reopened.goto(`/live?open=${id}`);
  await expect
    .poll(() => terminalText(reopened), { timeout: 30_000 })
    .toContain('/lfg 做一个计算器');
  expect(before).toContain('Claude Code');

  await reopened.getByTestId('live-panel').getByRole('button', { name: '结束进程' }).click();
  await expect(reopened.getByTestId('live-panel').getByTestId('live-status')).toHaveAttribute(
    'data-status',
    'exited',
    { timeout: 60_000 },
  );

  // Sessions：这个 session 标为"交互"；详情中的 resume 对话框默认用这个 variant 与记录的工作目录
  const sessionId = (await detail(id)).claudeSessionId;
  await reopened.goto(`/sessions/${sessionId}`);
  await expect(reopened.getByTestId('session-summary').getByTestId('live-badge')).toBeVisible();
  await reopened.getByTestId('resume-open').click();
  const dialog = reopened.getByTestId('resume-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId('resume-variant')).toHaveValue(variant.id);
  await expect(dialog.getByTestId('resume-cwd')).toContainText(`live/${id}/workspace`);
  await expect(dialog.getByRole('radio', { name: '人' })).toBeChecked();
  await reopened.screenshot({ path: '.work/screenshots/w30-resume-dialog.png' });
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toHaveCount(0);
  await reopened.close();
});
