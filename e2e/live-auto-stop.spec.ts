import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './test.js';
import { sessionLines } from '../server/test/helpers/session-copies.js';
import { liveAutoStopDir, liveAutoStopMs, liveAutoStopProjectsDir } from './services.js';

// 关闭页面后自动结束（Contracts 14.3），基础档：这对服务只有这个 spec 的页面连接，计时为 3 秒；Claude Code 是替身。
// 打开页面并 resume 一个短 session，关掉页面，等过计时，重新打开后这一项显示"页面关闭后自动结束"、结束时的终端输出与 resume
const source = path.join(liveAutoStopProjectsDir, '-w56-auto-stop');
const sessionId = randomUUID();
const shots = '.work/screenshots';

test('关掉页面、等过计时，重新打开后显示"页面关闭后自动结束"、终端输出与 resume', async ({
  browser,
  request,
}) => {
  test.setTimeout(120_000);
  const cwd = path.join(liveAutoStopDir, 'cwd');
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, `${sessionId}.jsonl`), sessionLines(sessionId, cwd));
  expect((await request.put('/api/sources', { data: { paths: [source] } })).status()).toBe(200);
  const imported = await request.post('/api/live/import', { data: { sessionIds: [sessionId] } });
  expect(imported.status()).toBe(201);
  const [item] = (await imported.json()) as { id: string }[];
  if (item === undefined) throw new Error('没有导入');

  // 打开页面后从这一项 resume（"本机配置"）：页面的 SSE 与终端的 WebSocket 都连着，进程一直运行
  const first = await browser.newContext();
  const page = await first.newPage();
  await page.goto(`/live?item=${item.id}`);
  await page.getByTestId('live-idle').getByTestId('resume-open').click();
  const dialog = page.getByTestId('resume-dialog');
  await expect(dialog.getByTestId('resume-variant')).toHaveValue('local');
  await dialog.getByTestId('resume-confirm').click();
  const panel = page.getByTestId('live-panel');
  await expect(panel.getByTestId('live-status')).toHaveAttribute('data-status', 'running');
  await expect(page.locator('.xterm-rows')).toContainText('替身');
  await page.waitForTimeout(liveAutoStopMs * 2);
  await expect(panel.getByTestId('live-status')).toHaveAttribute('data-status', 'running');

  // 关掉页面（所有连接断开），等过计时
  await first.close();
  const deadline = Date.now() + liveAutoStopMs + 20_000;
  for (;;) {
    const detail = (await (await request.get(`/api/live/${item.id}`)).json()) as {
      status: string;
    };
    if (detail.status === 'exited') break;
    if (Date.now() > deadline) throw new Error('页面关闭后进程没有自动结束');
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const second = await browser.newContext();
  const again = await second.newPage();
  await again.goto(`/live?item=${item.id}`);
  const listed = again.getByTestId('live-list').locator(`[data-live="${item.id}"]`);
  await expect(listed.getByTestId('live-status')).toHaveText('页面关闭后自动结束');
  await expect(listed.getByTestId('live-status')).toHaveAttribute('data-auto-stopped', 'true');
  const reopened = again.getByTestId('live-panel');
  await expect(reopened.getByTestId('live-auto-stopped')).toBeVisible();
  // 结束时的终端输出（回放 pty.log）与 resume 按钮
  await expect(again.locator('.xterm-rows')).toContainText('替身');
  await expect(reopened.getByTestId('live-toolbar').getByTestId('resume-open')).toBeEnabled();
  await again.screenshot({ path: `${shots}/w56-auto-stopped.png` });
  await again.setViewportSize({ width: 1280, height: 800 });
  await expect(reopened.getByTestId('live-auto-stopped')).toBeVisible();
  await again.screenshot({ path: `${shots}/w56-auto-stopped-1280.png` });
  await again.setViewportSize({ width: 1600, height: 1000 });

  // resume 后又在运行，不再显示自动结束
  await reopened.getByTestId('live-toolbar').getByTestId('resume-open').click();
  await again.getByTestId('resume-dialog').getByTestId('resume-confirm').click();
  await expect(reopened.getByTestId('live-status')).toHaveAttribute('data-status', 'running');
  await expect(reopened.getByTestId('live-auto-stopped')).toHaveCount(0);
  const stopped = await request.post(`/api/live/${item.id}/stop`);
  expect(stopped.status()).toBe(200);
  await second.close();
});
