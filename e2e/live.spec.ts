import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type APIRequestContext, expect, type Page, test } from './test.js';
import type { LiveDetail, LiveSummary } from '../server/src/live/views.js';
import { runsServerPort } from '../ports.js';

// 交互区（Contracts 14）：用能证明行为的最少真实调用——real 环境的 /lfg 只等初始消息提交就结束进程，
// resume 与导入后的 resume 都在启动后结束，不等模型回答。
// 新建表单；终端中出现 Claude Code 的界面并能输入；resume 后左侧项数不变、选中原标签页；双击改名、Esc 取消、回车保存；
// Sessions 中显示新名字；导入本机 session 的选择框与导入后 resume；关掉页面重开后输出仍在
const api = `http://127.0.0.1:${String(runsServerPort)}/api`;
const marker = randomUUID().slice(0, 8);
const realCwd = path.resolve('.work/w34/e2e-real-cwd');

// 要导入的 session：还不在交互区、记录的工作目录存在（数据目录在多次运行之间保留，导入过的不能再导入）。
// prepare-runs-e2e 导入的 run session 是这个池子；用完时删掉整个 .work/e2e/runs-data 由它重建
// （只删数据库时，variant 的 home 中 resume 复制的 session 与重新导入的原文件冲突）
async function importable(request: APIRequestContext): Promise<string> {
  const response = await request.get(`${api}/sessions?limit=500`);
  const { sessions } = (await response.json()) as {
    sessions: { id: string; cwd: string | null; liveId: string | null; requestCount: number }[];
  };
  const candidates = sessions
    .filter((s) => s.liveId === null && s.cwd !== null && fs.existsSync(s.cwd))
    .sort((a, b) => a.requestCount - b.requestCount);
  const first = candidates[0];
  if (first === undefined) {
    throw new Error(
      '没有可以导入的 session：删掉整个 .work/e2e/runs-data，由 prepare-runs-e2e 重建',
    );
  }
  return first.id;
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `.work/screenshots/w34-${name}.png`, animations: 'disabled' });

// xterm.js 的 DOM 渲染用不换行空格
const terminalText = async (page: Page) =>
  ((await page.locator('.xterm-rows').textContent()) ?? '').replaceAll(' ', ' ');

test.describe.configure({ mode: 'serial' });

test('交互：新建、resume 在同一项、改名、Sessions 中的名字、导入本机 session 后 resume', async ({
  page,
  request,
}) => {
  test.setTimeout(1_800_000);
  fs.mkdirSync(realCwd, { recursive: true });
  if (!fs.existsSync(path.join(realCwd, '.git'))) execFileSync('git', ['init', '-q', realCwd]);
  const variantName = `W34 e2e ${marker}`;
  const created = await request.post(`${api}/variants`, {
    data: { name: variantName },
  });
  expect(created.ok()).toBe(true);
  const variant = (await created.json()) as { id: string };
  const built = await request.post(`${api}/variants/${variant.id}/build`, { timeout: 900_000 });
  expect(built.ok()).toBe(true);
  const detail = async (id: string) =>
    (await (await request.get(`${api}/live/${id}`)).json()) as LiveDetail;
  const list = async () => (await (await request.get(`${api}/live`)).json()) as LiveSummary[];
  const items = page.getByTestId('live-list').locator('[data-live]');

  // 新建表单（Contracts 29.2）：配置、初始命令（variant 默认它的入口命令）、输入、model 与 effort；real 环境的写入提示
  await page.goto('/live');
  await page.getByTestId('new-live-toggle').click();
  const form = page.getByTestId('new-live');
  await form.getByTestId('live-config').selectOption({ label: `${variantName} (lfg)` });
  await expect(form.getByTestId('live-command')).toHaveValue('lfg');
  await form.getByRole('textbox', { name: '输入' }).fill('做一个计算器');
  await expect(form.getByTestId('live-initial')).toHaveText('/lfg 做一个计算器');
  await expect(form.getByTestId('live-model')).toHaveValue('opus');
  await expect(form.getByTestId('live-effort')).toHaveValue('high');
  await form.getByText('real：在你填的真实目录中运行').click();
  await expect(form.getByTestId('real-warning')).toContainText(
    '会在真实目录、真实仓库与真实工单上写入',
  );
  await form.getByRole('textbox', { name: '工作目录' }).fill(realCwd);
  await form.getByTestId('live-start').click();

  const panel = page.getByTestId('live-panel');
  await expect(panel).toBeVisible({ timeout: 120_000 });
  const id = (await panel.getAttribute('data-live')) ?? '';
  expect(id).toMatch(/^l-\d{8}-[a-z0-9]{6}$/);
  await expect(panel.getByTestId('live-variant-name')).toHaveText(variantName);
  await expect.poll(() => terminalText(page), { timeout: 120_000 }).toContain('Claude Code');
  // 目录未被这个配置信任时 Claude Code 先询问：在终端里选 Yes 回车
  const terminal = page.getByTestId('live-terminal');
  if ((await terminalText(page)).includes('Yes, I trust this folder')) {
    await terminal.click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
  }
  await expect
    .poll(
      async () =>
        (await detail(id)).events.some(
          (e) => e.kind === 'hook' && e.payload.hook_event_name === 'UserPromptSubmit',
        ),
      { timeout: 120_000, intervals: [1000] },
    )
    .toBe(true);
  await expect.poll(() => terminalText(page), { timeout: 60_000 }).toContain('/lfg 做一个计算器');
  // 在终端中输入：文字出现在 Claude Code 的输入框
  await terminal.click();
  await page.keyboard.type('W34E2E');
  await expect.poll(() => terminalText(page)).toContain('W34E2E');
  await panel.getByRole('button', { name: '结束进程' }).click();
  await expect(panel.getByTestId('live-status')).toHaveAttribute('data-status', 'exited', {
    timeout: 60_000,
  });

  // resume：左侧项数不变，仍是这一项的标签页，终端接着显示
  // 数据目录在多次运行之间保留，其中可能已有同名的项：按 id 找这一项
  const count = await items.count();
  await expect(page.getByTestId('live-list').locator(`[data-live="${id}"]`)).toHaveCount(1);
  await shot(page, 'list-before-resume');
  await panel.getByTestId('resume-open').click();
  const dialog = page.getByTestId('resume-dialog');
  await expect(dialog.getByTestId('resume-variant')).toHaveValue(variant.id);
  await dialog.getByRole('button', { name: 'resume' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel.getByTestId('live-status')).toHaveAttribute('data-status', 'running');
  await expect(items).toHaveCount(count);
  const tab = page.getByTestId('live-tab').and(page.locator(`[data-live="${id}"]`));
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('live-list').locator(`[data-live="${id}"]`)).toContainText(
    'resume 1 次',
  );
  // 运行中不能再 resume
  await expect(panel.getByTestId('resume-open')).toHaveCount(0);
  await expect.poll(() => terminalText(page), { timeout: 60_000 }).toContain('resume');
  // 回放之前进程的输出时 xterm.js 回答其中的查询，这些回答不能作为输入写进新进程（会回显成 ^[[?1;2c）
  await page.waitForTimeout(3000);
  expect(await terminalText(page)).not.toContain('?1;2c');
  await shot(page, 'list-after-resume');
  const resumed = await detail(id);
  // Claude Code 的项建出时就有 session id
  const sessionId = resumed.claudeSessionId;
  if (sessionId === null) throw new Error(`交互 ${id} 没有 session id`);
  expect(resumed.processes.map((p) => p.kind)).toEqual(['start', 'resume']);
  expect((await list()).filter((l) => l.claudeSessionId === sessionId)).toHaveLength(1);
  await panel.getByRole('button', { name: '结束进程' }).click();
  await expect(panel.getByTestId('live-status')).toHaveAttribute('data-status', 'exited', {
    timeout: 60_000,
  });

  // 改名：左侧双击，Esc 取消；标签页点铅笔图标，回车保存
  const listTitle = page.getByTestId('live-list').locator(`[data-live="${id}"]`);
  await listTitle.getByTestId('live-title').dblclick();
  await listTitle.getByTestId('live-title-input').fill('不会保存的名字');
  await listTitle.getByTestId('live-title-input').press('Escape');
  await expect(listTitle.getByTestId('live-title')).toHaveText('/lfg 做一个计算器');
  await tab.getByTestId('live-title-rename').click();
  await tab.getByTestId('live-title-input').fill(`W34 计算器 ${marker}`);
  await shot(page, 'renaming');
  await tab.getByTestId('live-title-input').press('Enter');
  await expect(tab.getByTestId('live-title')).toHaveText(`W34 计算器 ${marker}`);
  await expect(listTitle.getByTestId('live-title')).toHaveText(`W34 计算器 ${marker}`);
  // 空白的名字以原文报错，保持编辑
  await listTitle.getByTestId('live-title').dblclick();
  await listTitle.getByTestId('live-title-input').fill('   ');
  await listTitle.getByTestId('live-title-input').press('Enter');
  await expect(listTitle.getByRole('alert')).toContainText('名字不能为空');
  await listTitle.getByTestId('live-title-input').press('Escape');

  // Sessions 列表与详情显示新名字
  await page.goto('/sessions');
  await page
    .getByRole('region', { name: '管理的 session' })
    .getByPlaceholder('搜索标题、目录或 session id')
    .fill(sessionId);
  const row = page.getByTestId('session-row').filter({ hasText: sessionId.slice(0, 8) });
  await expect(row).toContainText(`W34 计算器 ${marker}`);
  // 列表的 workflow 列没有"交互"标记，每行有 Live 按钮（Contracts 18.1）
  await expect(row.getByTestId('live-badge')).toHaveCount(0);
  await expect(row.getByTestId('open-in-live')).toBeVisible();
  await shot(page, 'sessions-name');
  await page.goto(`/sessions/${sessionId}`);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(`W34 计算器 ${marker}`);

  // 导入本机 session：已在交互区的不可选；导入后左侧多一项、未运行，显示对话与 resume 按钮
  await page.goto('/live');
  const before = await items.count();
  const runSession = await importable(request);
  await page.getByTestId('import-open').click();
  const picker = page.getByTestId('import-dialog');
  // 三列中找到这个 session：它所在的配置与项目（工作目录），再在第三列中搜索
  const findInPicker = async (id: string) => {
    const s = (await (await request.get(`${api}/sessions/${id}`)).json()) as {
      config: string;
      cwd: string;
    };
    await picker.locator(`[data-testid="import-config"][data-config="${s.config}"]`).click();
    await picker.getByRole('searchbox', { name: '搜索项目' }).fill(s.cwd);
    await picker.locator(`[data-testid="import-project"][data-cwd="${s.cwd}"]`).click();
    await picker.getByRole('searchbox', { name: '搜索磁盘上的 session' }).fill(id);
    return picker.locator(`[data-testid="disk-session"][data-session="${id}"]`);
  };
  const taken = await findInPicker(sessionId);
  await expect(taken.getByTestId('import-taken')).toHaveText('已在交互区');
  await expect(taken.getByRole('checkbox')).toBeDisabled();
  await (await findInPicker(runSession)).getByRole('checkbox').check();
  await shot(page, 'import-picker');
  await picker.getByTestId('import-confirm').click();
  await expect(picker).toHaveCount(0);
  await expect(items).toHaveCount(before + 1);
  const imported = (await list()).find((l) => l.claudeSessionId === runSession);
  if (imported === undefined) throw new Error('没有导入');
  expect(imported.status).toBe('idle');
  const importedPanel = page.locator(`[data-testid="live-panel"][data-live="${imported.id}"]`);
  await expect(importedPanel.getByTestId('live-status')).toHaveAttribute('data-status', 'idle');
  await expect(importedPanel.getByTestId('live-idle')).toBeVisible();
  await expect(importedPanel.getByTestId('conversation')).toBeVisible();
  await shot(page, 'imported-idle');
  // 从这一项 resume：仍是同一项
  await importedPanel.getByTestId('live-idle').getByTestId('resume-open').click();
  await page.getByTestId('resume-dialog').getByRole('button', { name: 'resume' }).click();
  await expect(importedPanel.getByTestId('live-status')).toHaveAttribute('data-status', 'running');
  await expect(items).toHaveCount(before + 1);
  expect((await detail(imported.id)).processes.map((p) => p.kind)).toEqual(['resume']);
  await importedPanel.getByRole('button', { name: '结束进程' }).click();
  await expect(importedPanel.getByTestId('live-status')).toHaveAttribute('data-status', 'exited', {
    timeout: 60_000,
  });

  // 关掉页面重开：这一项的输出仍在（第一个进程的输出与 resume 的分隔行）
  await page.goto(`/live?item=${id}`);
  await expect.poll(() => terminalText(page), { timeout: 30_000 }).toContain('resume');
});
