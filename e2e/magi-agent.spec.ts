import fs from 'node:fs';
import path from 'node:path';
import { checkContrast, nonTextContrast, themes, setTheme } from './contrast.js';
import { magiAgentWorktree } from './services.js';
import { expect, type Page, test } from './test.js';

// Magi Agent（Contracts 第 23 节），基础档：主仓库是 .work/ 下的本地 git 仓库，worktree 在它旁边；Claude Code 与
// Codex 是回显参数的替身命令，不调用模型。左上角的按钮在任何页面打开当前会话（默认 Codex），第一次打开时建 worktree，
// Live 列表中当前会话固定在最上面；菜单选引擎与新会话；工具栏的分支状态、部署的结果与全屏
const shots = '.work/screenshots';

async function shoot(page: Page, name: string) {
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1600, height: 1000 },
  ]) {
    await page.setViewportSize(size);
    await page.screenshot({ path: `${shots}/w60-${name}-${String(size.width)}.png` });
  }
}

test('左上角的 Magi Agent：打开当前会话、第一次打开时建 worktree，列表中固定在最上面；选引擎、新会话、部署的结果与全屏', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  // 任何页面都能打开：从 Sessions 页面点
  await page.goto('/sessions');
  const button = page.getByTestId('magi-agent-open');
  await expect(button).toHaveAttribute('data-engine', 'codex');
  await button.click();
  await expect(page).toHaveURL(/\/live\?item=l-/);
  const panel = page.getByTestId('live-panel');
  await expect(panel).toHaveAttribute('data-purpose', 'agent');
  // worktree 建好、依赖装好之后启动 Codex（替身），终端中是它回显的参数：没有沙箱、MAGI.md 作为 developer_instructions
  await expect(panel.getByTestId('live-status')).toHaveAttribute('data-status', 'running', {
    timeout: 60_000,
  });
  await expect(page.locator('.xterm-rows')).toContainText('Codex 替身');
  await expect(page.locator('.xterm-rows')).toContainText('dangerously-bypass-approvals-and-sandbox');
  expect(fs.existsSync(path.join(magiAgentWorktree, 'node_modules'))).toBe(true);
  await expect(panel.getByTestId('live-engine')).toHaveText('Codex');
  await expect(panel.getByTestId('magi-branch')).toContainText('magi-agent');
  await expect(panel.getByTestId('magi-branch-counts')).toHaveText('· 领先 0 · 落后 0 · 未提交 0');
  await expect(panel.getByTestId('magi-current')).toHaveText('当前会话');
  const codexId = new URL(page.url()).searchParams.get('item');
  const pinned = page.getByTestId('live-pinned');
  await expect(pinned.locator(`[data-live="${String(codexId)}"]`)).toBeVisible();
  await expect(pinned.getByTestId('live-purpose')).toHaveText('Magi Agent');
  await shoot(page, 'magi-codex');

  // 菜单中选 Claude Code（记在 localStorage），按钮打开 Claude Code 的当前会话
  await page.getByTestId('magi-agent-menu').click();
  await page.locator('[data-testid="magi-engine"][data-engine="claude"]').click();
  await expect(button).toHaveAttribute('data-engine', 'claude');
  await button.click();
  await expect(panel.getByTestId('live-engine')).toHaveText('Claude Code');
  await expect(panel.getByTestId('live-status')).toHaveAttribute('data-status', 'running');
  await expect(page.locator('.xterm-rows')).toContainText('Claude Code 替身');
  const claudeId = new URL(page.url()).searchParams.get('item');
  expect(claudeId).not.toBe(codexId);
  // 两个当前会话都固定在最上面，在用途筛选之外
  await page.getByTestId('live-purpose-filter').locator('[data-value="design"]').click();
  await expect(pinned.locator('[data-pinned="true"]')).toHaveCount(2);
  await page.getByTestId('live-purpose-filter').locator('[data-value="all"]').click();
  await page.reload();
  await expect(button).toHaveAttribute('data-engine', 'claude');

  // 明暗两种主题下 Magi Agent 的色带与标签
  for (const theme of themes) {
    await setTheme(page, theme);
    const item = pinned.locator(`[data-live="${String(claudeId)}"]`);
    expect(
      await nonTextContrast(item.getByTestId('live-purpose-band'), 'background-color', item),
      `${theme} 的 Magi Agent 色带`,
    ).toBeGreaterThanOrEqual(3);
  }
  await setTheme(page, 'light');
  await checkContrast(page, 'magi-agent', { screenshot: true });

  // 工具栏的"新会话"：新建一个并记为当前，之前的会话移到普通位置，用途仍为 Magi Agent
  await panel.getByTestId('magi-new').click();
  await expect(page).not.toHaveURL(new RegExp(`item=${String(claudeId)}`));
  await expect(panel.getByTestId('live-status')).toHaveAttribute('data-status', 'running');
  const list = page.getByTestId('live-list');
  await expect(list.locator(`[data-live="${String(claudeId)}"]`)).toHaveAttribute(
    'data-purpose',
    'agent',
  );
  const newId = new URL(page.url()).searchParams.get('item');
  await expect(pinned.locator(`[data-live="${String(newId)}"]`)).toBeVisible();

  // 部署的结果：worktree 有未提交的改动时第 1 步失败，工具栏显示失败的一步与日志链接
  fs.writeFileSync(path.join(magiAgentWorktree, 'draft.md'), '还没有提交\n');
  await expect(panel.getByTestId('magi-branch-counts')).toHaveText('· 领先 0 · 落后 0 · 未提交 1');
  const deploy = await request.post('/api/magi-agent/deploy', { data: { liveId: newId } });
  expect(deploy.status()).toBe(409);
  expect(((await deploy.json()) as { message: string }).message).toContain('draft.md');
  const status = panel.getByTestId('magi-deploy');
  await expect(status).toHaveAttribute('data-status', 'failed');
  await expect(status).toContainText('上一次部署失败：worktree 没有未提交的改动');
  const log = await request.get(String(await status.getByTestId('magi-deploy-log').getAttribute('href')));
  expect(await log.text()).toContain('draft.md');
  await shoot(page, 'magi-deploy-failed');

  // 终端可以全屏（Contracts 第 20 节）
  await panel.getByTestId('fullscreen-toggle').click();
  await expect(page.getByTestId('live-fullscreen')).toHaveAttribute('data-fullscreen', 'true');
  await shoot(page, 'magi-fullscreen');
  await page.keyboard.press('Control+Shift+F');

  for (const id of [codexId, claudeId, newId]) {
    const detail = (await (await request.get(`/api/live/${String(id)}`)).json()) as {
      status: string;
    };
    if (detail.status === 'running') await request.post(`/api/live/${String(id)}/stop`);
  }
});
