import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page, test } from './test.js';
import { z } from 'zod';
import { liveItemsProjectsDir } from './services.js';
import { openLog } from '../server/test/setup/basic-tier.js';

// 交互项的关闭、显示已关闭的项、删除，导入选择框（与 Sessions 页面相同的来源勾选与列表），Sessions 的 Live 按钮
// （Contracts 14.5）。服务端的来源目录每次删除重建，这里放入两个目录：一个短 session（"请记住暗号"），
// 与 51 个它的副本（超过一页的 50 条）。只导入不启动，不调用 claude
const fixture = path.resolve(
  import.meta.dirname,
  '../server/test/fixtures/live/cfa31f10-e280-4908-bcf7-cbe9b00fbe53.jsonl',
);
const shortSource = path.join(liveItemsProjectsDir, '-w39-short');
const manySource = path.join(liveItemsProjectsDir, '-w39-many');
const title = '请记住暗号：青蛙-47。只回答：记住了';
const shots = '.work/screenshots';

// fixture 的一份副本，换成新的 session id
function copySession(dir: string, sessionId: string) {
  const lines = fs
    .readFileSync(fixture, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const entry = z.looseObject({}).parse(JSON.parse(l));
      if ('sessionId' in entry) entry.sessionId = sessionId;
      return JSON.stringify(entry);
    });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), `${lines.join('\n')}\n`);
}

const shortSession = randomUUID();

const LiveItem = z.object({ id: z.string(), claudeSessionId: z.string() });
async function liveItems(page: Page) {
  const response = await page.request.get('/api/live?includeHidden=true');
  return z.array(LiveItem).parse(await response.json());
}
async function itemOf(page: Page) {
  const item = (await liveItems(page)).find((l) => l.claudeSessionId === shortSession);
  if (item === undefined) throw new Error('这个 session 不在交互区');
  return item;
}

test.describe.configure({ mode: 'serial' });

test.beforeAll(() => {
  copySession(shortSource, shortSession);
  for (let i = 0; i < 51; i++) copySession(manySource, randomUUID());
});

test('导入选择框：勾选新的来源目录后它的 session 出现并能导入；超过一页能翻到；已在交互区的不可选', async ({
  page,
}) => {
  await page.goto('/live');
  await page.getByTestId('import-open').click();
  const picker = page.getByTestId('import-dialog');
  // 与 Sessions 页面相同的来源勾选：一个都没勾选时展开
  await picker.getByRole('checkbox', { name: shortSource, exact: true }).click();
  await expect(picker.getByTestId('import-result')).toContainText('已导入');
  const row = picker.locator(`[data-session="${shortSession}"]`);
  await expect(row).toContainText(title);
  await row.getByRole('checkbox').check();
  await picker.getByTestId('import-confirm').click();
  await expect(picker).toHaveCount(0);
  const item = await itemOf(page);
  const listed = page.locator(`[data-testid="live-list"] [data-live="${item.id}"]`);
  await expect(listed).toBeVisible();
  await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('data-live', item.id);
  await expect(listed.getByTestId('live-status')).toHaveAttribute('data-status', 'idle');

  // 第二个来源目录有 51 个 session：第一页 50 条，"加载更多"后全部列出；已导入的那个标为"已在交互区"
  await page.getByTestId('import-open').click();
  // 已有勾选的目录时来源列表默认收起
  await picker.getByRole('button', { name: /来源目录/ }).click();
  await picker.getByRole('checkbox', { name: manySource, exact: true }).click();
  await expect(picker.getByTestId('import-result')).toContainText('51 个 session 有更新');
  await expect(picker.getByTestId('session-row')).toHaveCount(50);
  await picker.getByTestId('load-more').click();
  await expect(picker.getByTestId('session-row')).toHaveCount(52);
  const taken = picker.locator(`[data-session="${shortSession}"]`);
  await expect(taken.getByTestId('import-taken')).toHaveText('已在交互区');
  await expect(taken.getByRole('checkbox')).toBeDisabled();
  await taken.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/w39-import-picker.png`, animations: 'disabled' });
  await picker.getByRole('button', { name: '取消' }).click();

  // 在这里勾选等同于在 Sessions 页面勾选
  await page.goto('/sessions');
  await expect(page.getByRole('button', { name: /来源目录/ })).toContainText('已勾选 2 / 2');
  await page.getByRole('button', { name: /来源目录/ }).click();
  await expect(page.getByRole('checkbox', { name: shortSource, exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: manySource, exact: true })).toBeChecked();
});

test('×关闭、显示已关闭的项、恢复显示；已关闭的项在导入选择框中可选，选了即恢复显示', async ({
  page,
}) => {
  const item = await itemOf(page);
  await page.goto('/live');
  const listed = page.locator(`[data-testid="live-list"] [data-live="${item.id}"]`);
  await listed.hover();
  await expect(listed.getByTestId('live-hide')).toBeEnabled();
  await page.screenshot({ path: `${shots}/w39-hide-button.png`, animations: 'disabled' });
  await listed.getByTestId('live-hide').click();
  await expect(listed).toHaveCount(0);

  await page.getByTestId('show-hidden').check();
  await expect(listed).toHaveAttribute('data-hidden', 'true');
  await page.screenshot({ path: `${shots}/w39-hidden-items.png`, animations: 'disabled' });
  await listed.getByTestId('live-unhide').click();
  await expect(listed).toHaveAttribute('data-hidden', 'false');
  await page.getByTestId('show-hidden').uncheck();
  await expect(listed).toBeVisible();

  // 再关闭一次，从导入选择框选它：恢复显示，仍是同一项
  await listed.getByTestId('live-hide').click();
  await expect(listed).toHaveCount(0);
  const before = (await liveItems(page)).length;
  await page.getByTestId('import-open').click();
  const picker = page.getByTestId('import-dialog');
  await picker.getByPlaceholder('搜索标题、目录或 session id').fill(shortSession);
  const row = picker.locator(`[data-session="${shortSession}"]`);
  await expect(row.getByRole('checkbox')).toBeEnabled();
  await row.getByRole('checkbox').check();
  await picker.getByTestId('import-confirm').click();
  await expect(picker).toHaveCount(0);
  await expect(listed).toHaveAttribute('data-hidden', 'false');
  expect((await liveItems(page)).length).toBe(before);
});

test('Sessions 的 Live 按钮：到达交互区并选中这一项、未运行；再点一次不新增；已关闭的项恢复显示', async ({
  page,
}) => {
  const item = await itemOf(page);
  const before = (await liveItems(page)).length;
  const open = async () => {
    await page.goto('/sessions');
    await page.getByPlaceholder('搜索标题、目录或 session id').fill(shortSession);
    const row = page.getByTestId('session-row').filter({ hasText: shortSession.slice(0, 8) });
    await expect(page.getByTestId('session-row')).toHaveCount(1);
    await expect(row).toHaveCount(1);
    await page.screenshot({ path: `${shots}/w39-sessions-live.png`, animations: 'disabled' });
    await row.getByTestId('open-in-live').click();
    await expect(page).toHaveURL(new RegExp(`/live\\?item=${item.id}$`));
    await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('data-live', item.id);
    const panel = page.locator(`[data-testid="live-panel"][data-live="${item.id}"]`);
    await expect(panel.getByTestId('live-status')).toHaveAttribute('data-status', 'idle');
  };
  await open();
  await open();
  expect((await liveItems(page)).length).toBe(before);

  // 详情页头部的 Live 按钮：已关闭的项恢复显示
  const listed = page.locator(`[data-testid="live-list"] [data-live="${item.id}"]`);
  await listed.getByTestId('live-hide').click();
  await expect(listed).toHaveCount(0);
  await page.goto(`/sessions/${shortSession}`);
  const summary = page.getByTestId('session-summary');
  // 不属于 run 与 isolated 交互项的 session 没有绑定的对象：不显示按钮（Contracts 18.2）
  await expect(summary.getByTestId('open-in-live')).toBeVisible();
  await expect(summary.getByTestId('session-links-open')).toHaveCount(0);
  // 工作区：点击后服务端执行 open <cwd>（基础档的 open 只记下参数，test/setup/basic-bin/open）
  const workspace = summary.getByTestId('session-workspace');
  const cwd = (await workspace.textContent()) ?? '';
  const opened = page.waitForResponse((r) => r.url().endsWith('/api/open'));
  await workspace.click();
  expect((await opened).status()).toBe(200);
  expect(fs.readFileSync(openLog, 'utf8').split('\n')).toContain(cwd);
  await summary.getByTestId('open-in-live').click();
  await expect(page).toHaveURL(new RegExp(`/live\\?item=${item.id}$`));
  await expect(listed).toHaveAttribute('data-hidden', 'false');
  expect((await liveItems(page)).length).toBe(before);
});

test('删除：确认框列出删除与不删除的内容，输入名字前按钮不可用；删除后项不在，session 仍在', async ({
  page,
}) => {
  const item = await itemOf(page);
  await page.goto('/live');
  const listed = page.locator(`[data-testid="live-list"] [data-live="${item.id}"]`);
  await listed.getByTestId('live-menu').click();
  await page.getByTestId('live-delete').click();
  const dialog = page.getByTestId('delete-dialog');
  await expect(dialog).toContainText(`data/live/${item.id}/`);
  await expect(dialog).toContainText('不会删除');
  const confirm = dialog.getByTestId('delete-confirm');
  await expect(confirm).toBeDisabled();
  await dialog.getByTestId('delete-confirm-input').fill(`${title}x`);
  await expect(confirm).toBeDisabled();
  await dialog.getByTestId('delete-confirm-input').fill(title);
  await expect(confirm).toBeEnabled();
  await page.screenshot({ path: `${shots}/w39-delete-dialog.png`, animations: 'disabled' });
  await confirm.click();
  await expect(dialog).toHaveCount(0);
  await expect(listed).toHaveCount(0);
  expect((await liveItems(page)).some((l) => l.id === item.id)).toBe(false);
  expect((await page.request.get(`/api/live/${item.id}`)).status()).toBe(404);
  const session = z
    .object({ liveId: z.string().nullable() })
    .parse(await (await page.request.get(`/api/sessions/${shortSession}`)).json());
  expect(session.liveId).toBeNull();
});
