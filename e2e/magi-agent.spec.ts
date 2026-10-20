import fs from 'node:fs';
import path from 'node:path';
import { checkContrast, nonTextContrast, themes, setTheme } from './contrast.js';
import { magiAgentWorktree } from './services.js';
import { expect, type Page, test } from './test.js';

// Magi Agent（Contracts 第 23 节），基础档：主仓库是 .work/ 下的本地 git 仓库，worktree 在它旁边；Claude Code 与
// Codex 是回显参数的替身命令，不调用模型。左上角的小机器人在任何页面弹出选择框：引擎（默认 Codex）、配置（Codex 只有
// 本机配置，Claude Code 可选构建成功的 variant）、继续最近的或更早的会话或新会话，选择记在 localStorage。Live 列表中
// Magi Agent 的项与其他项一样排列，用途筛选的第五项，可以关闭与删除；工具栏的配置、分支状态、部署的结果与全屏
const shots = '.work/screenshots';

async function shoot(page: Page, name: string) {
  for (const size of [
    { width: 1280, height: 800 },
    { width: 1600, height: 1000 },
  ]) {
    await page.setViewportSize(size);
    await page.screenshot({ path: `${shots}/w67-${name}-${String(size.width)}.png` });
  }
}

const itemOf = (page: Page) => new URL(page.url()).searchParams.get('item') ?? '';

test('小机器人的弹出框：默认值与记住的选择、Codex 只有本机配置、继续最近的或更早的会话与新会话、variant 的配置；列表中的筛选、关闭与删除', async ({
  page,
  request,
}) => {
  test.setTimeout(180_000);
  // 一个构建成功的 variant（任意 workflow 的 variant 由 dashboard 构建，不用 wf）
  const flowId = `magi-e2e-${String(Date.now())}`;
  const made = await request.post('/api/workflows', {
    data: {
      id: flowId,
      name: 'Magi 配置',
      description: '',
      definition: { id: flowId, name: 'Magi 配置', stages: [{ id: 'step' }] },
    },
  });
  expect(made.status()).toBe(201);
  const variants = (await (await request.get('/api/variants')).json()) as {
    id: string;
    name: string;
    workflowId: string;
  }[];
  const variant = variants.find((v) => v.workflowId === flowId);
  if (variant === undefined) throw new Error(`workflow ${flowId} 没有建出初稿`);
  expect((await request.post(`/api/variants/${variant.id}/build`)).status()).toBe(200);
  const variantName = `${variant.name} (${flowId})`;

  // 任何页面都能打开：从 Sessions 页面点。第一次：Codex、本机配置（不可选 variant）、只有新会话
  await page.goto('/sessions');
  const robot = page.getByTestId('magi-agent');
  // 悬停时轻轻上下浮动；系统要求减少动态效果时不动
  const motion = () =>
    robot.getByTestId('magi-robot').evaluate((el) => getComputedStyle(el).animationName);
  await robot.hover();
  await expect.poll(motion).toBe('magi-float');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(motion).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await robot.click();
  const popover = page.getByTestId('magi-popover');
  await expect(popover.getByTestId('engine-choice')).toHaveAttribute('data-engine', 'codex');
  const config = popover.getByTestId('magi-config-select');
  await expect(config).toHaveValue('local');
  await expect(config).toBeDisabled();
  await expect(config.locator('option')).toHaveText(['本机配置']);
  await expect(popover.getByTestId('magi-session-continue')).toHaveCount(0);
  await expect(popover.getByTestId('magi-session-new')).toBeChecked();
  await expect(popover.getByTestId('magi-summary')).toHaveText('新建一个 Codex 的会话');
  await shoot(page, 'popover-first');
  await popover.getByTestId('magi-open').click();

  await expect(page).toHaveURL(/\/live\?item=l-/);
  await expect(popover).toHaveCount(0);
  const panel = page.getByTestId('live-panel');
  await expect(panel).toHaveAttribute('data-purpose', 'agent');
  // worktree 建好、依赖装好之后启动 Codex（替身），终端中是它回显的参数：没有沙箱、MAGI.md 作为 developer_instructions
  await expect(panel.getByTestId('live-status')).toHaveAttribute('data-status', 'running', {
    timeout: 60_000,
  });
  await expect(page.locator('.xterm-rows')).toContainText('Codex 替身');
  await expect(page.locator('.xterm-rows')).toContainText(
    'dangerously-bypass-approvals-and-sandbox',
  );
  expect(fs.existsSync(path.join(magiAgentWorktree, 'node_modules'))).toBe(true);
  await expect(panel.getByTestId('live-engine')).toHaveText('Codex');
  await expect(panel.getByTestId('magi-config')).toHaveText('本机配置');
  await expect(panel.getByTestId('magi-branch')).toContainText('magi-agent');
  await expect(panel.getByTestId('magi-branch-counts')).toHaveText('· 领先 0 · 落后 0 · 未提交 0');
  const first = itemOf(page);
  // 列表中与其他项一样排列；用途只以色带与小机器人标出，没有用途标签；名字是"新会话"，一行；没有固定在上方的区域
  const list = page.getByTestId('live-list');
  const firstItem = list.locator(`[data-live="${first}"]`);
  await expect(firstItem).toHaveAttribute('data-purpose', 'agent');
  await expect(firstItem.getByTestId('magi-robot')).toHaveCount(1);
  await expect(firstItem.getByTestId('live-purpose')).toHaveCount(0);
  await expect(firstItem.getByTestId('live-title')).toHaveText('新会话');
  await expect(page.getByTestId('live-pinned')).toHaveCount(0);
  // 在终端中提交第一条消息：这一项以它命名，列表中一行截断，悬停显示全文
  const firstMessage = '帮我看看 Live 列表在窄的窗口中为什么会折行，还有标题为什么被截断';
  await page.locator('.xterm-screen').click();
  await page.keyboard.type(firstMessage);
  await page.keyboard.press('Enter');
  const firstTitle = Array.from(firstMessage).slice(0, 40).join('');
  await expect(firstItem.getByTestId('live-title')).toHaveText(firstTitle);
  await expect(firstItem.getByTestId('live-title')).toHaveAttribute('title', firstTitle);
  const titleBox = await firstItem.getByTestId('live-title').boundingBox();
  expect(titleBox?.height ?? 0).toBeLessThan(24);

  // 第二次：记住的 Codex，默认继续这个会话；改为新会话
  await robot.click();
  await expect(popover.getByTestId('magi-session-continue')).toBeChecked();
  await expect(popover.getByTestId('magi-session-select')).toHaveValue(first);
  await expect(popover.getByTestId('magi-summary')).toHaveText('打开运行中的会话');
  await popover.getByTestId('magi-session-new').check();
  await popover.getByTestId('magi-open').click();
  await expect(page).not.toHaveURL(new RegExp(`item=${first}`));
  await expect(panel.getByTestId('live-status')).toHaveAttribute('data-status', 'running');
  const second = itemOf(page);

  // 更早的会话：先结束它，在下拉中选它，打开时 resume
  await request.post(`/api/live/${first}/stop`);
  await expect(firstItem.getByTestId('live-status')).toHaveAttribute('data-status', 'exited');
  await robot.click();
  // 记下的是上次新建的那一个；选更早的一个
  await expect(popover.getByTestId('magi-session-continue')).toBeChecked();
  const sessionSelect = popover.getByTestId('magi-session-select');
  await expect(sessionSelect).toHaveValue(second);
  await expect(sessionSelect.locator('option')).toHaveCount(2);
  await sessionSelect.selectOption(first);
  await expect(popover.getByTestId('magi-summary')).toHaveText('打开并 resume 这个会话');
  await popover.getByTestId('magi-open').click();
  await expect(page).toHaveURL(new RegExp(`item=${first}`));
  await expect(panel.getByTestId('live-status')).toHaveAttribute('data-status', 'running');
  // 又起了一个进程（替身没有写出会话记录，以同一项重新启动）
  const reopened = (await (await request.get(`/api/live/${first}`)).json()) as {
    processes: unknown[];
  };
  expect(reopened.processes).toHaveLength(2);

  // Claude Code：配置可选构建成功的 variant；这个引擎与配置下还没有会话，只有新会话
  await robot.click();
  await popover.locator('[data-testid="engine-choice"] button[data-engine="claude"]').click();
  await expect(config).toBeEnabled();
  await expect(config.locator('option')).toContainText(['本机配置', variantName]);
  await config.selectOption(variant.id);
  await expect(popover.getByTestId('magi-session-continue')).toHaveCount(0);
  await expect(popover.getByTestId('magi-summary')).toHaveText('新建一个 Claude Code 的会话');
  await shoot(page, 'popover-claude');
  await popover.getByTestId('magi-open').click();
  await expect(panel.getByTestId('live-engine')).toHaveText('Claude Code');
  await expect(panel.getByTestId('magi-config')).toHaveText(variantName);
  await expect(panel.getByTestId('live-status')).toHaveAttribute('data-status', 'running');
  await expect(page.locator('.xterm-rows')).toContainText('Claude Code 替身');
  const claude = itemOf(page);
  await expect(list.locator(`[data-live="${claude}"]`)).toContainText(variantName);

  // 重新载入后弹出框预选上次的三项：Claude Code、这个 variant、继续这个会话
  await page.reload();
  await robot.click();
  await expect(popover.getByTestId('engine-choice')).toHaveAttribute('data-engine', 'claude');
  await expect(config).toHaveValue(variant.id);
  await expect(popover.getByTestId('magi-session-select')).toHaveValue(claude);
  await shoot(page, 'popover-remembered');

  // 明暗两种主题：小机器人的轮廓与导航栏的底色（亮色下是深色的面罩，暗色下是浅色的身体）、Magi Agent 的色带
  for (const theme of themes) {
    await setTheme(page, theme);
    const outline = robot.locator(`[data-part="${theme === 'light' ? 'face' : 'body'}"]`);
    expect(
      await nonTextContrast(outline, 'fill', robot),
      `${theme} 的小机器人`,
    ).toBeGreaterThanOrEqual(3);
    await robot.locator('xpath=..').screenshot({ path: `${shots}/w67-nav-${theme}.png` });
    const item = list.locator(`[data-live="${claude}"]`);
    expect(
      await nonTextContrast(item.getByTestId('live-purpose-band'), 'background-color', item),
      `${theme} 的 Magi Agent 色带`,
    ).toBeGreaterThanOrEqual(3);
    await shoot(page, `popover-${theme}`);
  }
  await page.keyboard.press('Escape');
  await setTheme(page, 'light');
  await checkContrast(page, 'magi-agent', { screenshot: true });

  // 用途筛选是一个下拉，第五项"Magi Agent"：三项都是 Magi Agent 的会话
  const filter = page.getByTestId('live-purpose-filter');
  await expect(filter.locator('option[value="agent"]')).toHaveText('Magi Agent 3');
  await filter.selectOption('interaction');
  await expect(list).toHaveCount(0);
  await filter.selectOption('agent');
  await expect(list.locator('[data-live][data-purpose="agent"]')).toHaveCount(3);
  await shoot(page, 'live-list');
  await filter.selectOption('all');

  // 关闭：结束进程后"×"，只从列表隐藏
  await request.post(`/api/live/${second}/stop`);
  const secondItem = list.locator(`[data-live="${second}"]`);
  await expect(secondItem.getByTestId('live-status')).toHaveAttribute('data-status', 'exited');
  await secondItem.getByTestId('live-hide').click();
  await expect(secondItem).toHaveCount(0);

  // 删除：确认框写明磁盘上的 session 文件不删除
  await request.post(`/api/live/${claude}/stop`);
  const claudeItem = list.locator(`[data-live="${claude}"]`);
  await expect(claudeItem.getByTestId('live-status')).toHaveAttribute('data-status', 'exited');
  await claudeItem.getByTestId('live-menu').click();
  await page.getByTestId('live-delete').click();
  const dialog = page.getByTestId('delete-dialog');
  await expect(dialog.getByTestId('delete-agent-files')).toContainText(
    `磁盘上的 session 文件（variant ${variantName} 的配置目录下的）`,
  );
  await shoot(page, 'delete');
  await dialog.getByTestId('delete-confirm-input').fill('新会话');
  await dialog.getByTestId('delete-confirm').click();
  await expect(claudeItem).toHaveCount(0);
  expect((await request.get(`/api/live/${claude}`)).status()).toBe(404);

  // 部署的结果：worktree 有未提交的改动时第 1 步失败，工具栏显示失败的一步与日志链接
  await list.locator(`[data-live="${first}"]`).click();
  fs.writeFileSync(path.join(magiAgentWorktree, 'draft.md'), '还没有提交\n');
  await expect(panel.getByTestId('magi-branch-counts')).toHaveText('· 领先 0 · 落后 0 · 未提交 1');
  const deploy = await request.post('/api/magi-agent/deploy', { data: { liveId: first } });
  expect(deploy.status()).toBe(409);
  expect(((await deploy.json()) as { message: string }).message).toContain('draft.md');
  const status = panel.getByTestId('magi-deploy');
  await expect(status).toHaveAttribute('data-status', 'failed');
  await expect(status).toContainText('上一次部署失败：worktree 没有未提交的改动');
  const log = await request.get(
    String(await status.getByTestId('magi-deploy-log').getAttribute('href')),
  );
  expect(await log.text()).toContain('draft.md');
  await shoot(page, 'deploy-failed');

  // 终端可以全屏（Contracts 第 20 节）
  await panel.getByTestId('fullscreen-toggle').click();
  await expect(page.getByTestId('live-fullscreen')).toHaveAttribute('data-fullscreen', 'true');
  await shoot(page, 'fullscreen');
  await page.keyboard.press('Control+Shift+F');

  await request.post(`/api/live/${first}/stop`);
});
