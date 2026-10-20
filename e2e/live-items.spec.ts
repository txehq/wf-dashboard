import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Locator, type Page, test } from './test.js';
import { z } from 'zod';
import { fixtureCwd } from './fixture-cwd.js';
import { holdRequest } from './hold-request.js';
import { liveItemsProjectsDir } from './services.js';
import { openLog } from '../server/test/setup/basic-tier.js';

// 交互项的关闭、显示已关闭的项、删除，导入选择框（与 Sessions 页面相同的三列），Sessions 页面的导入与管理表格的分页、
// 清除，Sessions 的 Live 按钮（Contracts 14.5、25.1）。服务端的来源目录每次删除重建，这里放入两个目录：一个短 session
// （"请记住暗号"），与 51 个它的副本（同一个工作目录，超过一页的 50 个）；另有 51 个各放一个副本、工作目录为 x-w69-NN
// 的目录（项目超过一页的 50 个）。只导入不启动，不调用 claude
const fixture = path.resolve(
  import.meta.dirname,
  '../server/test/fixtures/live/cfa31f10-e280-4908-bcf7-cbe9b00fbe53.jsonl',
);
const shortSource = path.join(liveItemsProjectsDir, '-w39-short');
const manySource = path.join(liveItemsProjectsDir, '-w39-many');
const pagedName = (n: number) => `x-w69-${String(n).padStart(2, '0')}`;
const title = '请记住暗号：青蛙-47。只回答：记住了';
const shots = '.work/screenshots';
const sizes = [
  { width: 1280, height: 800 },
  { width: 1600, height: 1000 },
] as const;

// fixture 的一份副本，换成新的 session id（与给出的工作目录）
function copySession(dir: string, sessionId: string, cwd?: string) {
  const lines = fs
    .readFileSync(fixture, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const entry = z.looseObject({}).parse(JSON.parse(l));
      if ('sessionId' in entry) entry.sessionId = sessionId;
      if (cwd !== undefined && 'cwd' in entry) entry.cwd = cwd;
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
  for (let i = 0; i < 51; i++)
    copySession(
      path.join(liveItemsProjectsDir, `-${pagedName(i)}`),
      randomUUID(),
      `/Users/tester/${pagedName(i)}`,
    );
});

// 三列中 52 个 session 的那个项目（两个来源目录记下同一个工作目录，合为一个项目）：fixture 中记下的工作目录
const bigCwd = fixtureCwd(fixture);
const bigProject = (scope: Locator) =>
  scope.locator(`[data-testid="import-project"][data-cwd="${bigCwd}"]`);
const diskRow = (scope: Locator, id: string) =>
  scope.locator(`[data-testid="disk-session"][data-session="${id}"]`);

// 换一个搜索词、新的结果还没有到达时（拦下这次请求），空结果的说明仍是列出的那次搜索的词；到达后换成新的词。
// 最后清空搜索框
async function heldSearch(
  page: Page,
  scope: Locator,
  box: Locator,
  { pathname, empty }: { pathname: string; empty: (q: string) => string },
) {
  await box.fill('w89-none-a');
  await expect(scope.getByText(empty('w89-none-a'))).toBeVisible();
  const release = await holdRequest(page, pathname, { q: 'w89-none-b' });
  const sent = page.waitForRequest(
    (r) => new URL(r.url()).pathname === pathname && r.url().includes('q=w89-none-b'),
  );
  await box.fill('w89-none-b');
  await sent;
  await expect(scope.getByText(empty('w89-none-a'))).toBeVisible();
  release();
  await expect(scope.getByText(empty('w89-none-b'))).toBeVisible();
  await box.fill('');
}

test('导入选择框：三列的点选、搜索与分页，勾选后导入进交互区与管理表格；已在交互区的不可选', async ({
  page,
}) => {
  await page.goto('/live');
  await page.getByTestId('import-open').click();
  const picker = page.getByTestId('import-dialog');
  // 第一列默认是第一个配置（本机配置）
  await expect(picker.getByTestId('import-config').first()).toHaveAttribute('aria-current', 'true');
  await expect(picker.getByTestId('import-config').first()).toContainText('本机配置');

  // 第二列：52 个项目，每页 50 个；搜索后回到第一页
  const projectPager = picker.getByTestId('project-pager');
  await expect(projectPager.getByTestId('project-pager-range')).toHaveText('1–50，共 52 个项目');
  await expect(picker.getByTestId('import-project')).toHaveCount(50);
  // 第二页的数据还没有到达时，页数与列表都还是第一页
  const releaseProjects = await holdRequest(page, '/api/session-import/projects', { page: '2' });
  await projectPager.getByRole('button', { name: '下一页' }).click();
  await expect(projectPager.getByTestId('project-pager-page')).toHaveText('1 / 2');
  await expect(picker.getByTestId('import-project')).toHaveCount(50);
  await expect(picker.getByTestId('import-projects')).toHaveAttribute('aria-busy', 'true');
  releaseProjects();
  await expect(picker.getByTestId('import-project')).toHaveCount(2);
  await expect(projectPager.getByTestId('project-pager-page')).toHaveText('2 / 2');
  await picker.getByRole('searchbox', { name: '搜索项目' }).fill(pagedName(3));
  await expect(projectPager.getByTestId('project-pager-range')).toHaveText('共 1 个项目');
  await expect(picker.getByTestId('import-project')).toHaveText(new RegExp(`^${pagedName(3)}1$`));
  await heldSearch(page, picker, picker.getByRole('searchbox', { name: '搜索项目' }), {
    pathname: '/api/session-import/projects',
    empty: (q) => `没有符合「${q}」的项目。`,
  });
  await picker.getByRole('searchbox', { name: '搜索项目' }).fill('');

  // 第三列：这个项目的 52 个 session，每页 50 个
  await bigProject(picker).click();
  const diskPager = picker.getByTestId('disk-pager');
  await expect(diskPager.getByTestId('disk-pager-range')).toHaveText('1–50，共 52 个 session');
  await expect(picker.getByTestId('disk-session')).toHaveCount(50);
  await diskPager.getByRole('button', { name: '下一页' }).click();
  await expect(picker.getByTestId('disk-session')).toHaveCount(2);
  await heldSearch(page, picker, picker.getByRole('searchbox', { name: '搜索磁盘上的 session' }), {
    pathname: '/api/session-import/sessions',
    empty: (q) => `没有符合「${q}」的 session。`,
  });
  // 搜索 session id：回到第一页，只剩这一个
  await picker.getByRole('searchbox', { name: '搜索磁盘上的 session' }).fill(shortSession);
  await expect(diskPager.getByTestId('disk-pager-range')).toHaveText('共 1 个 session');
  const row = diskRow(picker, shortSession);
  await expect(row).toContainText(title);
  await row.getByRole('checkbox').check();
  await expect(picker.getByTestId('import-confirm')).toHaveText('导入 1 个');
  await picker.getByTestId('import-confirm').click();
  await expect(picker).toHaveCount(0);
  const item = await itemOf(page);
  const listed = page.locator(`[data-testid="live-list"] [data-live="${item.id}"]`);
  await expect(listed).toBeVisible();
  await expect(page.getByRole('tab', { selected: true })).toHaveAttribute('data-live', item.id);
  await expect(listed.getByTestId('live-status')).toHaveAttribute('data-status', 'idle');
  // 同时进入了管理表格
  const managed = z
    .object({ total: z.number() })
    .parse(await (await page.request.get(`/api/sessions?q=${shortSession}`)).json());
  expect(managed.total).toBe(1);

  // 再打开：它标为"已在交互区"，不能勾选；本页的全选不含它
  await page.getByTestId('import-open').click();
  await bigProject(picker).click();
  await picker.getByRole('searchbox', { name: '搜索磁盘上的 session' }).fill(shortSession);
  await expect(diskRow(picker, shortSession).getByTestId('import-taken')).toHaveText('已在交互区');
  await expect(diskRow(picker, shortSession).getByRole('checkbox')).toBeDisabled();
  await picker.getByRole('searchbox', { name: '搜索磁盘上的 session' }).fill('');
  await expect(picker.getByTestId('disk-session')).toHaveCount(50);
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.screenshot({
      path: `${shots}/w69-import-picker-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }
  await picker.getByRole('button', { name: '取消' }).click();
});

test('Sessions 页面：本页的全选与翻页后导入 51 个，管理表格每页 50 个；清除后不在表格中，上面可以重新导入', async ({
  page,
}) => {
  await page.goto('/sessions');
  const panel = page.getByTestId('import-panel');
  await bigProject(panel).click();
  // 已导入的默认勾选、可以取消（它在交互区中但没有运行中的进程，能清除）
  await panel.getByRole('searchbox', { name: '搜索磁盘上的 session' }).fill(shortSession);
  await expect(diskRow(panel, shortSession).getByTestId('disk-imported')).toHaveText('已导入');
  await expect(diskRow(panel, shortSession).getByRole('checkbox')).toBeChecked();
  await expect(diskRow(panel, shortSession).getByRole('checkbox')).toBeEnabled();
  await panel.getByRole('searchbox', { name: '搜索磁盘上的 session' }).fill('');
  await expect(panel.getByTestId('disk-session')).toHaveCount(50);

  const selectPage = panel.getByTestId('import-select-page');
  await selectPage.check();
  await panel.getByTestId('disk-pager').getByRole('button', { name: '下一页' }).click();
  await expect(panel.getByTestId('disk-session')).toHaveCount(2);
  await selectPage.check();
  const apply = panel.getByTestId('import-apply');
  await expect(apply).toHaveText('应用：导入 51 个');
  await expect(bigProject(panel)).toContainText('已导入 1 / 52（+51）');
  await apply.click();
  await expect(panel.getByTestId('import-result')).toHaveText('已导入 51 个', { timeout: 60_000 });
  await expect(apply).toHaveText('应用');
  await expect(apply).toBeDisabled();

  // 管理表格：52 个，每页 50 个
  const pager = page.getByTestId('session-pager');
  await expect(pager.getByTestId('session-pager-range')).toHaveText('1–50，共 52 个 session');
  await expect(page.getByTestId('session-row')).toHaveCount(50);
  const releaseRows = await holdRequest(page, '/api/sessions', { page: '2' });
  await pager.getByRole('button', { name: '下一页' }).click();
  await expect(pager.getByTestId('session-pager-page')).toHaveText('1 / 2');
  await expect(page.getByTestId('session-row')).toHaveCount(50);
  releaseRows();
  await expect(page.getByTestId('session-row')).toHaveCount(2);
  await expect(pager.getByTestId('session-pager-page')).toHaveText('2 / 2');
  // 按配置筛选时回到第一页
  await page.getByTestId('session-config-filter').selectOption('local');
  await expect(pager.getByTestId('session-pager-page')).toHaveText('1 / 2');
  const tableSearch = page.getByRole('searchbox', { name: '搜索 session', exact: true });
  await heldSearch(page, page.locator('body'), tableSearch, {
    pathname: '/api/sessions',
    empty: (q) => `没有符合「${q}」的 session。`,
  });
  await tableSearch.fill('');
  await expect(page.getByTestId('session-row')).toHaveCount(50);

  // 1280×800 下上面的三列不把表格挤出屏幕：表格的前三行在屏幕内
  for (const size of sizes) {
    await page.setViewportSize(size);
    const third = await page.getByTestId('session-row').nth(2).boundingBox();
    expect((third?.y ?? Infinity) + (third?.height ?? 0)).toBeLessThan(size.height);
    await page.screenshot({
      path: `${shots}/w69-sessions-paged-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }

  // 清除一个（不是交互区中的那个）：从表格中去掉，磁盘上的文件不动，上面的第三列中不再是已导入
  const cleared = page
    .getByTestId('session-row')
    .and(page.locator(`:not([data-session="${shortSession}"])`))
    .first();
  const clearedId = (await cleared.getAttribute('data-session')) ?? '';
  await cleared.getByRole('checkbox').check();
  await page.getByTestId('selection-actions').getByTestId('session-clear').click();
  await expect(pager.getByTestId('session-pager-range')).toHaveText('1–50，共 51 个 session');
  await expect(
    page.locator(`[data-testid="session-row"][data-session="${clearedId}"]`),
  ).toHaveCount(0);
  expect(fs.existsSync(path.join(manySource, `${clearedId}.jsonl`))).toBe(true);
  await panel.getByRole('searchbox', { name: '搜索磁盘上的 session' }).fill(clearedId);
  const again = diskRow(panel, clearedId);
  await expect(again.getByTestId('disk-imported')).toHaveCount(0);
  // 从上面重新导入后又出现
  await again.getByRole('checkbox').check();
  await apply.click();
  await expect(pager.getByTestId('session-pager-range')).toHaveText('1–50，共 52 个 session');
});

test('Sessions 页面：取消勾选已导入的即待清除、与导入一起应用，改动跨翻页与换项目保留，撤销改动', async ({
  page,
}) => {
  await page.goto('/sessions');
  const panel = page.getByTestId('import-panel');
  const apply = panel.getByTestId('import-apply');
  const undo = panel.getByTestId('import-undo');
  await expect(bigProject(panel)).toContainText('已导入 52 / 52');
  await bigProject(panel).click();
  await expect(panel.getByTestId('disk-session')).toHaveCount(50);
  // 本页第一个不是交互区中的那个
  const first = panel
    .getByTestId('disk-session')
    .and(page.locator(`:not([data-session="${shortSession}"])`))
    .first();
  const clearedId = (await first.getAttribute('data-session')) ?? '';
  const cleared = diskRow(panel, clearedId);
  await expect(cleared.getByRole('checkbox')).toBeEnabled();

  // 取消勾选：左侧标"− 清除"，计数与按钮随之变化；再点一次恢复原状
  await cleared.getByRole('checkbox').uncheck();
  await expect(cleared).toHaveAttribute('data-change', 'clear');
  await expect(cleared.getByTestId('disk-change')).toHaveText('− 清除');
  await expect(bigProject(panel)).toContainText('已导入 52 / 52（−1）');
  await expect(apply).toHaveText('应用：清除 1 个');
  await cleared.getByRole('checkbox').check();
  await expect(cleared).not.toHaveAttribute('data-change');
  await expect(bigProject(panel)).toContainText(/已导入 52 \/ 52$/);
  await expect(apply).toBeDisabled();
  await expect(undo).toHaveCount(0);

  // 撤销改动：全部回到原状
  await cleared.getByRole('checkbox').uncheck();
  await undo.click();
  await expect(cleared.getByRole('checkbox')).toBeChecked();
  await expect(cleared).not.toHaveAttribute('data-change');
  await expect(apply).toHaveText('应用');

  // 取消一个已导入的，再到另一个项目勾选一个未导入的；翻页、换项目后改动仍在
  await cleared.getByRole('checkbox').uncheck();
  await panel.getByRole('searchbox', { name: '搜索项目' }).fill(pagedName(7));
  const other = panel.locator(
    `[data-testid="import-project"][data-cwd="/Users/tester/${pagedName(7)}"]`,
  );
  await other.click();
  await expect(panel.getByTestId('disk-session')).toHaveCount(1);
  const freshId = (await panel.getByTestId('disk-session').getAttribute('data-session')) ?? '';
  const fresh = diskRow(panel, freshId);
  await expect(fresh.getByRole('checkbox')).not.toBeChecked();
  await fresh.getByRole('checkbox').check();
  await expect(fresh.getByTestId('disk-change')).toHaveText('+ 导入');
  await expect(other).toContainText('已导入 0 / 1（+1）');
  await expect(apply).toHaveText('应用：导入 1 个，清除 1 个');
  await panel.getByRole('searchbox', { name: '搜索项目' }).fill('');
  await bigProject(panel).click();
  await panel.getByTestId('disk-pager').getByRole('button', { name: '下一页' }).click();
  await expect(panel.getByTestId('disk-session')).toHaveCount(2);
  await panel.getByTestId('disk-pager').getByRole('button', { name: '上一页' }).click();
  await expect(cleared).toHaveAttribute('data-change', 'clear');
  await expect(cleared.getByRole('checkbox')).not.toBeChecked();
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.screenshot({
      path: `${shots}/w70-sessions-changes-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }

  // 应用：先导入再清除，不需要确认；下面的表格随之更新，暂存清空
  await apply.click();
  await expect(panel.getByTestId('import-result')).toHaveText('已导入 1 个，已清除 1 个');
  await expect(apply).toHaveText('应用');
  await expect(
    page.locator(`[data-testid="session-row"][data-session="${clearedId}"]`),
  ).toHaveCount(0);
  const managed = async (q: string) =>
    z
      .object({ total: z.number() })
      .parse(await (await page.request.get(`/api/sessions?q=${q}`)).json()).total;
  expect(await managed(clearedId)).toBe(0);
  expect(await managed(freshId)).toBe(1);
  await expect(page.getByTestId('session-pager-range')).toHaveText('1–50，共 52 个 session');
  await expect(cleared.getByRole('checkbox')).not.toBeChecked();
  await expect(cleared).not.toHaveAttribute('data-change');
  await expect(bigProject(panel)).toContainText(/已导入 51 \/ 52$/);
  expect(fs.existsSync(path.join(manySource, `${clearedId}.jsonl`))).toBe(true);
});

// W74（Contracts 25.1）：清除只在管理表格中隐藏，交互项照常显示这个 session 的对话与 resume；resume 的预检不改变清除
test('交互项的 session 清除后：交互项照常显示对话与 resume；从上面重新导入后回到管理表格', async ({
  page,
}) => {
  const item = await itemOf(page);
  await page.goto('/sessions');
  await page.getByPlaceholder('搜索标题、目录或 session id').fill(shortSession);
  const row = page.locator(`[data-testid="session-row"][data-session="${shortSession}"]`);
  // 等搜索的结果列出后再勾选：搜索词生效时清空选择（Contracts 25.1），之前勾选的会被清掉
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  await row.getByRole('checkbox').check();
  await page.getByTestId('selection-actions').getByTestId('session-clear').click();
  await expect(row).toHaveCount(0);

  await page.goto(`/live?item=${item.id}`);
  const panel = page.locator(`[data-testid="live-panel"][data-live="${item.id}"]`);
  const idle = panel.getByTestId('live-idle');
  await expect(idle.getByTestId('conversation')).toBeVisible();
  await expect(idle.getByTestId('conversation')).toContainText(title);
  await expect(idle.getByRole('alert')).toHaveCount(0);
  await idle.getByTestId('resume-open').click();
  await expect(page.getByTestId('resume-plan')).toBeVisible();
  await page.getByTestId('resume-dialog').getByRole('button', { name: '取消' }).click();
  const managed = async () =>
    z
      .object({ total: z.number() })
      .parse(await (await page.request.get(`/api/sessions?q=${shortSession}`)).json()).total;
  expect(await managed()).toBe(0);

  const imported = await page.request.post('/api/session-import', {
    data: { files: [path.join(shortSource, `${shortSession}.jsonl`)] },
  });
  expect(imported.status()).toBe(200);
  expect(await managed()).toBe(1);
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
  await bigProject(picker).click();
  await picker.getByRole('searchbox', { name: '搜索磁盘上的 session' }).fill(shortSession);
  const row = diskRow(picker, shortSession);
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

// 放在最后：选择全部后清除管理表格中的全部 session
test('管理表格的全选：表头选中本页、半选，翻页保留，改变搜索或筛选时清空；选择全部 N 个后分析与清除', async ({
  page,
}) => {
  await page.goto('/sessions');
  const pager = page.getByTestId('session-pager');
  await expect(pager.getByTestId('session-pager-range')).toHaveText('1–50，共 52 个 session');
  const rows = page.getByTestId('session-row');
  const header = page.getByTestId('session-select-page');
  const bar = page.getByTestId('selection-actions');
  const summary = bar.getByTestId('selection-summary');
  const selectAll = bar.getByTestId('select-all');
  const checkedRows = rows.getByRole('checkbox', { checked: true });

  // 表头选中本页；取消一行时半选，再选上恢复
  await header.check();
  await expect(checkedRows).toHaveCount(50);
  await expect(summary).toHaveText('已选本页 50 个');
  await expect(selectAll).toHaveText('选择全部 52 个');
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.screenshot({
      path: `${shots}/w73-select-page-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }
  const firstBox = rows.first().getByRole('checkbox');
  await firstBox.uncheck();
  await expect(header).toHaveJSProperty('indeterminate', true);
  await expect(header).not.toBeChecked();
  await expect(summary).toHaveText('已选 49 个');
  await expect(selectAll).toHaveCount(0);
  await firstBox.check();
  await expect(header).toHaveJSProperty('indeterminate', false);
  await expect(header).toBeChecked();

  // 翻页保留：第二页没有选的，逐个选一个后半选；回到第一页仍全部选中
  await pager.getByRole('button', { name: '下一页' }).click();
  await expect(rows).toHaveCount(2);
  await expect(header).not.toBeChecked();
  await expect(summary).toHaveText('已选 50 个');
  await rows.first().getByRole('checkbox').check();
  await expect(header).toHaveJSProperty('indeterminate', true);
  await expect(summary).toHaveText('已选 51 个');
  await pager.getByRole('button', { name: '上一页' }).click();
  await expect(checkedRows).toHaveCount(50);
  await expect(summary).toHaveText('已选 51 个（本页 50 个）');
  await expect(selectAll).toHaveText('选择全部 52 个');

  // 改变搜索与配置筛选时清空
  const search = page.getByPlaceholder('搜索标题、目录或 session id');
  await search.fill(shortSession);
  await expect(rows).toHaveCount(1);
  await expect(bar).toHaveCount(0);
  await search.fill('');
  await expect(rows).toHaveCount(50);
  await expect(checkedRows).toHaveCount(0);
  await header.check();
  await page.getByTestId('session-config-filter').selectOption('local');
  await expect(bar).toHaveCount(0);
  await expect(checkedRows).toHaveCount(0);

  // 选择全部 52 个：每页都选中
  await header.check();
  await selectAll.click();
  await expect(summary).toHaveText('已选全部 52 个');
  await expect(bar.getByTestId('session-clear')).toBeVisible();
  await pager.getByRole('button', { name: '下一页' }).click();
  await expect(rows.getByRole('checkbox', { checked: true })).toHaveCount(2);
  await expect(header).toBeChecked();
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.screenshot({
      path: `${shots}/w73-select-all-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }

  // 分析：全部 52 个 id 经本标签页的 sessionStorage 传给新建分析，地址只带一个键
  await bar.getByRole('button', { name: '分析这些 session' }).click();
  await expect(page).toHaveURL(/\/analyses\/new\?picked=[0-9a-f-]{36}$/);
  const form = page.getByTestId('analysis-settings');
  await expect(form.getByTestId('picked-item')).toHaveCount(52);
  await expect(form.getByTestId('picked-count')).toHaveText('已选 52 个');
  await expect(form.getByTestId('scope-local')).toBeVisible();
  await page.goBack();

  // 选择全部后清除：按服务端给出的全部 id，磁盘上的文件不动
  await expect(pager.getByTestId('session-pager-range')).toHaveText('1–50，共 52 个 session');
  await header.check();
  await selectAll.click();
  await expect(summary).toHaveText('已选全部 52 个');
  const sent = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith('/api/sessions/clear'),
  );
  await bar.getByTestId('session-clear').click();
  const body = z.object({ ids: z.array(z.string()) }).parse((await sent).postDataJSON());
  expect(new Set(body.ids).size).toBe(52);
  expect(body.ids).toContain(shortSession);
  await expect(page.getByText('还没有导入的 session。')).toBeVisible();
  const left = z
    .object({ total: z.number() })
    .parse(await (await page.request.get('/api/sessions?idsOnly=true')).json());
  expect(left.total).toBe(0);
  expect(fs.existsSync(path.join(shortSource, `${shortSession}.jsonl`))).toBe(true);
});
