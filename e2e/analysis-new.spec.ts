import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { expect, type Page, test } from './test.js';
import { api, session as boundSession, shots, sizes } from './analysis-helpers.js';
import { holdRequest } from './hold-request.js';
import { analysisWorkflowDir } from './services.js';

// 新建分析中直接从磁盘选择 session（Contracts 27）：左边与 Sessions 导入区相同的三列，右边固定的设置栏。数据：
// prepare-analysis-workflow-e2e 的短 session cfa31f10（在 workflow 记住暗号的初稿的配置目录中），加上这里放进本机配置的
// 它的副本：项目 w79-alpha 中 51 个（超过第三列一页的 50 个，其中 1 个先导入），项目 w79-beta 中 2 个。
// 基础档中分析的引擎调用失败，这里只看开始后跳到分析详情与读入
const fixture = path.resolve(
  import.meta.dirname,
  '../server/test/fixtures/live/cfa31f10-e280-4908-bcf7-cbe9b00fbe53.jsonl',
);
const projects = path.join(analysisWorkflowDir, 'projects');
const alpha = Array.from({ length: 51 }, () => randomUUID());
const beta = Array.from({ length: 2 }, () => randomUUID());
const importedId = alpha[0] ?? '';
const fileOf = (dir: string, id: string) => path.join(projects, dir, `${id}.jsonl`);
const SAME_CONFIG = '一次分析只能选同一个配置的 session，先清空已选';

test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  const lines = fs
    .readFileSync(fixture, 'utf8')
    .split('\n')
    .filter((l) => l !== '');
  for (const [dir, ids] of [
    ['-w79-alpha', alpha],
    ['-w79-beta', beta],
  ] as const) {
    // 上一次运行留下的副本
    fs.rmSync(path.join(projects, dir), { recursive: true, force: true });
    fs.mkdirSync(path.join(projects, dir), { recursive: true });
    for (const id of ids) {
      const copied = lines.map((l) => {
        const entry = z.looseObject({}).parse(JSON.parse(l));
        if ('sessionId' in entry) entry.sessionId = id;
        if ('cwd' in entry) entry.cwd = `/e2e/${dir.slice(1)}`;
        return JSON.stringify(entry);
      });
      fs.writeFileSync(fileOf(dir, id), `${copied.join('\n')}\n`);
    }
  }
  const imported = await request.post(`${api}/session-import`, {
    data: { engine: 'claude', files: [fileOf('-w79-alpha', importedId)] },
  });
  expect(imported.status(), await imported.text()).toBe(200);
});

const configButton = (page: Page, id: string) =>
  page.locator(`[data-testid="import-config"][data-config="${id}"]`);
const draft = (page: Page) =>
  page
    .getByRole('group', { name: '记住暗号' })
    .getByTestId('import-config')
    .filter({ hasText: '初稿' });
const projectButton = (page: Page, name: string) =>
  page.getByTestId('import-project').filter({ hasText: name });
const diskRow = (page: Page, id: string) =>
  page.locator(`[data-testid="disk-session"][data-session="${id}"]`);
const managed = async (page: Page, id: string) =>
  z
    .object({ ids: z.array(z.string()) })
    .parse(
      await (await page.request.get(`${api}/sessions?engine=claude&idsOnly=true&q=${id}`)).json(),
    ).ids;

test('从 Analyses 新建：三列中跨项目、跨页选择，其他配置与另一种引擎灰显，移除与清空，开始后读入', async ({
  page,
}) => {
  await page.goto('/analyses');
  await page.getByTestId('new-analysis').click();
  await expect(page).toHaveURL(/\/analyses\/new$/);
  const settings = page.getByTestId('analysis-settings');
  const count = settings.getByTestId('picked-count');
  const items = settings.getByTestId('picked-item');
  const start = settings.getByRole('button', { name: /开始分析/ });
  const codex = page
    .getByRole('radiogroup', { name: '视图' })
    .getByRole('radio', { name: /Codex/ });
  await expect(count).toHaveText('已选 0 个');
  await expect(start).toBeDisabled();
  await expect(draft(page)).toHaveAttribute('aria-disabled', 'false');

  // 本机配置 → 项目 w79-alpha：第三列 51 个，已导入的标出
  await configButton(page, 'local').click();
  await projectButton(page, 'w79-alpha').click();
  const range = page.getByTestId('disk-pager-range');
  await expect(range).toHaveText('1–50，共 51 个 session');
  await page.getByTestId('import-select-page').check();
  await expect(count).toHaveText('已选 50 个');
  // 第二页的数据还没有到达时，页数与列表都还是第一页
  const release = await holdRequest(page, '/api/session-import/sessions', { page: '2' });
  await page.getByTestId('disk-pager').getByRole('button', { name: '下一页' }).click();
  await expect(range).toHaveText('1–50，共 51 个 session');
  await expect(page.getByTestId('disk-session')).toHaveCount(50);
  await expect(page.getByTestId('import-sessions')).toHaveAttribute('aria-busy', 'true');
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.screenshot({
      path: `${shots}/w89-paging-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }
  release();
  await expect(range).toHaveText('51–51，共 51 个 session');
  await expect(page.getByTestId('disk-session')).toHaveCount(1);
  await page.getByTestId('disk-session').getByRole('checkbox').check();
  await expect(count).toHaveText('已选 51 个');
  // 换一个项目再选：跨项目累积
  await projectButton(page, 'w79-beta').click();
  const betaFirst = beta[0] ?? '';
  await diskRow(page, betaFirst).getByRole('checkbox').check();
  await expect(count).toHaveText('已选 52 个');
  await projectButton(page, 'w79-alpha').click();
  await expect(diskRow(page, importedId).getByTestId('disk-imported')).toHaveText('已导入');
  await expect(diskRow(page, importedId).getByRole('checkbox')).toBeChecked();

  // 已选了之后其他配置与另一种引擎灰显，悬停说明
  await expect(draft(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(draft(page)).toHaveAttribute('title', SAME_CONFIG);
  await expect(codex).toHaveAttribute('aria-disabled', 'true');
  await expect(codex).toHaveAttribute('title', SAME_CONFIG);
  // 点灰显的配置不切换（Playwright 不点 aria-disabled 的元素，这里强制点）
  await draft(page).click({ force: true });
  await expect(configButton(page, 'local')).toHaveAttribute('aria-current', 'true');
  await expect(settings.getByTestId('scope-config')).toHaveText('Claude Code · 本机配置');
  await expect(settings.getByTestId('scope-local')).toBeVisible();
  await expect(settings.getByTestId('scope-read-in')).toHaveText(
    '其中 51 个还不在 dashboard 中，开始时读入，不加进 Sessions 的管理表格。',
  );
  await expect(items.first()).toContainText('w79-alpha');
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.screenshot({
      path: `${shots}/w79-new-analysis-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }
  // 1280 宽时右栏不少于 300 px，左边的三列不超出
  await page.setViewportSize(sizes[0]);
  const panel = await settings.boundingBox();
  const columns = await page.getByTestId('import-columns').boundingBox();
  expect(panel?.width ?? 0).toBeGreaterThanOrEqual(300);
  expect((columns?.x ?? 0) + (columns?.width ?? 0)).toBeLessThanOrEqual(panel?.x ?? 0);

  // 右栏移除一个，第三列的勾选同时取消；清空后灰显恢复
  await settings
    .locator(`[data-testid="picked-item"][data-session="${importedId}"]`)
    .getByRole('button', { name: /^移除/ })
    .click();
  await expect(count).toHaveText('已选 51 个');
  await expect(diskRow(page, importedId).getByRole('checkbox')).not.toBeChecked();
  await settings.getByTestId('picked-clear').click();
  await expect(count).toHaveText('已选 0 个');
  await expect(draft(page)).toHaveAttribute('aria-disabled', 'false');
  await expect(codex).toHaveAttribute('aria-disabled', 'false');

  // 初稿的配置：选 cfa31f10，按 variant 初稿分析；本机配置灰显
  await draft(page).click();
  await page.getByTestId('import-project').first().click();
  await diskRow(page, boundSession).getByRole('checkbox').check();
  await expect(settings.getByTestId('scope-variant')).toHaveText('初稿');
  await expect(settings.getByTestId('scope-config')).toHaveText('Claude Code · 初稿 (记住暗号)');
  await expect(configButton(page, 'local')).toHaveAttribute('aria-disabled', 'true');
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.screenshot({
      path: `${shots}/w79-variant-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }
  await settings.getByTestId('picked-clear').click();

  // 选两个本机配置的（一个已导入、一个还不在 dashboard 中）后开始：跳到分析详情；读入的不在管理表格中
  const fresh = beta[1] ?? '';
  await configButton(page, 'local').click();
  await projectButton(page, 'w79-beta').click();
  await diskRow(page, fresh).getByRole('checkbox').check();
  await projectButton(page, 'w79-alpha').click();
  await diskRow(page, importedId).getByRole('checkbox').check();
  await expect(settings.getByTestId('scope-read-in')).toHaveText(
    '其中 1 个还不在 dashboard 中，开始时读入，不加进 Sessions 的管理表格。',
  );
  await start.click();
  await expect(page).toHaveURL(/\/analyses\/a-\d{8}-[a-z0-9]{6}$/);
  const id = page.url().split('/').pop() ?? '';
  const detail = z
    .object({ sessionIds: z.array(z.string()), variantId: z.string().nullable() })
    .parse(await (await page.request.get(`${api}/analyses/${id}`)).json());
  expect(detail).toEqual({ sessionIds: [fresh, importedId], variantId: null });
  expect((await page.request.get(`${api}/sessions/${fresh}`)).status()).toBe(200);
  expect(await managed(page, fresh)).toEqual([]);
  expect(await managed(page, importedId)).toEqual([importedId]);
});

test('带着选择进入（?sessions=）：选定它们所在的配置；不属于同一个配置时写明原因、不能开始，移除后可以开始', async ({
  page,
}) => {
  await page.goto(`/analyses/new?sessions=${boundSession},${importedId}`);
  const settings = page.getByTestId('analysis-settings');
  await expect(settings.getByTestId('picked-item')).toHaveCount(2);
  await expect(settings.getByTestId('scope-problem')).toHaveText(
    '所选 session 必须属于同一个配置，现在是：初稿 (记住暗号)、本机配置',
  );
  await expect(settings.getByRole('button', { name: /开始分析/ })).toBeDisabled();
  // 第一个（绑定初稿的）所在的配置被选定
  await expect(draft(page)).toHaveAttribute('aria-current', 'true');
  await expect(configButton(page, 'local')).toHaveAttribute('aria-disabled', 'true');
  await settings
    .locator(`[data-testid="picked-item"][data-session="${importedId}"]`)
    .getByRole('button', { name: /^移除/ })
    .click();
  await expect(settings.getByTestId('scope-variant')).toHaveText('初稿');
  await expect(settings.getByRole('button', { name: /开始分析/ })).toBeEnabled();
});
