import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { variantRenameProjectsDir } from './services.js';
import { expect, type Page, test } from './test.js';

// variant 改名（Contracts 16.4）：在 variant 页面改名，已打开的 Workflows 列表、Sessions 详情的绑定与 Live 的
// variant 名都由 variant.updated 刷新，不重新加载页面。服务端的 Claude Code 是替身命令：导入的短 session
// 以这个 variant resume（不调用 claude），variant 属于从空白新建的 workflow，构建不用 wf
const fixture = path.resolve(
  import.meta.dirname,
  '../server/test/fixtures/live/cfa31f10-e280-4908-bcf7-cbe9b00fbe53.jsonl',
);
const source = path.join(variantRenameProjectsDir, '-w51-rename');
const sessionId = randomUUID();
const marker = randomUUID().slice(0, 8);
const workflowId = `w51-${marker}`;
const workflowName = `改名 ${marker}`;
const shots = '.work/screenshots';
const sizes = [
  { width: 1280, height: 800 },
  { width: 1600, height: 1000 },
] as const;

const Variant = z.object({ id: z.string(), name: z.string(), workflowId: z.string() });
let variant = { id: '', name: '' };
let liveId = '';

// 第二个用例用第一个用例改出的名字
test.describe.configure({ mode: 'serial' });

test.beforeAll(async ({ request }) => {
  const lines = fs
    .readFileSync(fixture, 'utf8')
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => {
      const entry = z.looseObject({}).parse(JSON.parse(l));
      if ('sessionId' in entry) entry.sessionId = sessionId;
      return JSON.stringify(entry);
    });
  fs.mkdirSync(source, { recursive: true });
  fs.writeFileSync(path.join(source, `${sessionId}.jsonl`), `${lines.join('\n')}\n`);
  expect((await request.put('/api/sources', { data: { paths: [source] } })).status()).toBe(200);

  const created = await request.post('/api/workflows', {
    data: {
      id: workflowId,
      name: workflowName,
      description: '',
      definition: { id: workflowId, name: workflowName, stages: [{ id: `scan-${marker}` }] },
    },
  });
  expect(created.status()).toBe(201);
  const all = z.array(Variant).parse(await (await request.get('/api/variants')).json());
  const first = all.find((v) => v.workflowId === workflowId);
  if (first === undefined) throw new Error(`${workflowId} 没有初稿`);
  variant = first;
  const built = await request.post(`/api/variants/${variant.id}/build`);
  expect(built.status()).toBe(200);

  // session 绑定这个 variant；导入 Live 后以这个 variant resume（替身命令）
  const bound = await request.put(`/api/sessions/${sessionId}/binding`, {
    data: { variantId: variant.id },
  });
  expect(bound.status()).toBe(200);
  const imported = await request.post('/api/live/import', { data: { sessionIds: [sessionId] } });
  expect(imported.status()).toBe(201);
  liveId = z.array(z.object({ id: z.string() })).parse(await imported.json())[0]?.id ?? '';
  const resumed = await request.post('/api/live/resume', {
    data: { sessionId, variantId: variant.id, driver: 'human' },
  });
  expect(resumed.status()).toBe(201);
});

test.afterAll(async ({ request }) => {
  await request.post(`/api/live/${liveId}/stop`);
});

async function openWorkflows(page: Page) {
  await page.goto('/workflows');
  const row = page.getByTestId(`workflow-row-${workflowId}`);
  await row.getByRole('button', { name: `展开 ${workflowName} 的 variant` }).click();
  return page.getByTestId(`workflow-variants-${workflowId}`);
}

test('在 variant 页面改名：Workflows 列表、Sessions 的绑定与 Live 不重新加载即显示新名字', async ({
  context,
  page,
}) => {
  const renamed = `新名字 ${marker}`;
  await page.setViewportSize(sizes[0]);
  await page.goto(`/variants/${variant.id}`);
  const header = page.getByTestId('breadcrumb');
  await expect(header.getByTestId('variant-name')).toHaveText(variant.name);

  // 另外三个已打开的页面
  const workflows = await context.newPage();
  const list = await openWorkflows(workflows);
  await expect(list.getByTestId('variant-name')).toHaveText(variant.name);
  const sessionPage = await context.newPage();
  await sessionPage.goto(`/sessions/${sessionId}`);
  await expect(sessionPage.getByTestId('binding-variant')).toContainText(variant.name);
  const livePage = await context.newPage();
  await livePage.goto(`/live?item=${liveId}`);
  await expect(livePage.getByTestId('live-variant-name')).toHaveText(variant.name);

  // Esc 取消：名字不变
  await header.getByTestId('variant-name').dblclick();
  const input = header.getByTestId('variant-name-input');
  await expect(input).toBeFocused();
  await input.fill('不要的名字');
  await input.press('Escape');
  await expect(header.getByTestId('variant-name')).toHaveText(variant.name);

  // 双击改名，回车保存
  await header.getByTestId('variant-name').dblclick();
  await input.fill(`  ${renamed}  `);
  await page.screenshot({ path: `${shots}/w51-renaming-1280.png`, animations: 'disabled' });
  await input.press('Enter');
  await expect(header.getByTestId('variant-name')).toHaveText(renamed);
  await expect(page).toHaveTitle(/Workflows/);

  await expect(list.getByTestId('variant-name')).toHaveText(renamed);
  await expect(sessionPage.getByTestId('binding-variant')).toContainText(renamed);
  await expect(livePage.getByTestId('live-variant-name')).toHaveText(renamed);
  for (const size of sizes) {
    await workflows.setViewportSize(size);
    await workflows.screenshot({
      path: `${shots}/w51-workflows-${String(size.width)}.png`,
      animations: 'disabled',
    });
    await sessionPage.setViewportSize(size);
    await sessionPage.screenshot({
      path: `${shots}/w51-session-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }
  variant = { ...variant, name: renamed };
});

test('在 Workflows 列表中点铅笔改名；同名时显示服务端原文，输入框保留', async ({
  page,
  request,
}) => {
  const other = Variant.parse(
    await (
      await request.post(`/api/variants/${variant.id}/derive`, {
        data: { name: `另一个 ${marker}` },
      })
    ).json(),
  );
  await page.setViewportSize(sizes[1]);
  const list = await openWorkflows(page);
  const row = list.getByTestId(`variant-row-${other.name}`);
  await row.getByTestId('variant-name-rename').click();
  const input = row.getByTestId('variant-name-input');
  await input.fill(variant.name);
  await input.press('Enter');
  await expect(row.getByRole('alert')).toContainText(
    `返回 409：名称已被使用：${variant.name} (${workflowId})`,
  );
  await expect(input).toBeVisible();
  await page.screenshot({ path: `${shots}/w51-renaming-1600.png`, animations: 'disabled' });

  const next = `列表中改的名字 ${marker}`;
  await input.fill(next);
  await input.press('Enter');
  await expect(list.getByTestId(`variant-row-${next}`).getByTestId('variant-name')).toHaveText(
    next,
  );
  // 名字仍是链接：单击打开 variant 页面
  await list.getByRole('link', { name: next }).click();
  await expect(page).toHaveURL(new RegExp(`/variants/${other.id}$`));
  await expect(page.getByTestId('breadcrumb').getByTestId('variant-name')).toHaveText(next);
});
