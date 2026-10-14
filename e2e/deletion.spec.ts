import { randomUUID } from 'node:crypto';
import { expect, type Page, test } from './test.js';
import { serverPort } from '../ports.js';

// 删除 variant 与 workflow（Contracts 第 24 节）：确认对话框写明要删除的目录、关联 session 的两种选择与保留的记录，
// 输入名字后才能删除；最后一个 variant 不能单独删除。两种窗口下截图自查（Contracts 20.4）
const api = `http://127.0.0.1:${String(serverPort)}/api`;
const marker = randomUUID().slice(0, 6);
const shots = '.work/screenshots';
const sizes = [
  { width: 1280, height: 800 },
  { width: 1600, height: 1000 },
] as const;

interface Variant {
  id: string;
  name: string;
  workflowId: string;
}

test.describe.configure({ mode: 'serial' });

async function newFlow(page: Page, prefix: string, extra: string[]) {
  const id = `${prefix}-${marker}`;
  const made = await page.request.post(`${api}/workflows`, {
    data: {
      id,
      name: `删除 ${prefix} ${marker}`,
      description: '',
      definition: { id, name: `删除 ${prefix} ${marker}`, stages: [{ id: 'step' }] },
    },
  });
  expect(made.status()).toBe(201);
  const all = (await (await page.request.get(`${api}/variants`)).json()) as Variant[];
  const first = all.find((v) => v.workflowId === id);
  if (first === undefined) throw new Error(`workflow ${id} 没有建出初稿`);
  const derived: Variant[] = [];
  for (const name of extra) {
    const r = await page.request.post(`${api}/variants/${first.id}/derive`, { data: { name } });
    expect(r.status()).toBe(201);
    derived.push((await r.json()) as Variant);
  }
  return { id, name: `删除 ${prefix} ${marker}`, first, derived };
}

async function shoot(page: Page, name: string) {
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.screenshot({
      path: `${shots}/w61-${name}-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }
}

test('删除 variant：头部的「删除」打开对话框，写明目录、两种选择与保留的记录，输入名字后删除，回到 workflow 页面', async ({
  page,
}) => {
  const flow = await newFlow(page, 'variant', ['要删的']);
  const [victim] = flow.derived;
  if (victim === undefined) throw new Error('没有派生出 variant');
  await page.goto(`/variants/${victim.id}`);
  // 「删除」在头部已有的按钮组中
  await page.getByTestId('variant-actions').getByTestId('delete-variant').click();
  const dialog = page.getByTestId('delete-dialog');
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText('删除 variant 要删的');
  await expect(dialog.getByTestId('delete-dirs')).toContainText(`/variants/${victim.id}`);
  await expect(dialog.getByTestId('delete-retained')).toContainText('run 0 个');
  // 两种选择：默认改绑到本机配置；选一起删除时列出 session 的文件
  await expect(dialog.getByTestId('delete-sessions-rebind')).toBeChecked();
  await expect(dialog.getByTestId('delete-rebind-target')).toHaveValue('');
  await expect(dialog.getByTestId('delete-rebind-target').locator('option').first()).toHaveText(
    '本机配置（不绑定）',
  );
  await dialog.getByTestId('delete-sessions-delete').check();
  await expect(dialog.getByTestId('delete-rebind-target')).toBeDisabled();
  await dialog.getByTestId('delete-sessions-rebind').check();
  await dialog.getByTestId('delete-rebind-target').selectOption(flow.first.id);
  // 输入名字后才能删除
  const confirm = dialog.getByTestId('delete-confirm');
  await expect(confirm).toBeDisabled();
  await dialog.getByTestId('delete-confirm-name').fill('要删');
  await expect(confirm).toBeDisabled();
  await dialog.getByTestId('delete-confirm-name').fill('要删的');
  await expect(confirm).toBeEnabled();
  await shoot(page, 'delete-variant');
  await confirm.click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${flow.id}$`));
  await expect(page.getByTestId('variant-row-要删的')).toHaveCount(0);
  await expect(page.getByTestId(`variant-row-${flow.first.name}`)).toBeVisible();
  // 已删除的 variant 页面只显示它已删除
  await page.goto(`/variants/${victim.id}`);
  await expect(page.getByTestId('variant-deleted')).toContainText(`要删的（已删除） (${flow.id})`);
});

test('最后一个 variant 不能单独删除：对话框列出原因，删除按钮不能点', async ({ page }) => {
  const flow = await newFlow(page, 'lone', []);
  await page.goto(`/workflows/${flow.id}`);
  await page.getByTestId(`delete-variant-${flow.first.id}`).click();
  const dialog = page.getByTestId('delete-dialog');
  await expect(dialog.getByTestId('delete-blockers')).toContainText(
    `初稿 是 workflow ${flow.id} 的最后一个 variant，不能单独删除；要删就删除 workflow`,
  );
  await dialog.getByTestId('delete-confirm-name').fill('初稿');
  await expect(dialog.getByTestId('delete-confirm')).toBeDisabled();
  await shoot(page, 'delete-blocked');
  await dialog.getByRole('button', { name: '取消' }).click();
});

test('删除 workflow：Workflows 列表行中的删除图标，一起删除全部 variant；内置 workflow 没有删除', async ({
  page,
}) => {
  const flow = await newFlow(page, 'workflow', ['另一个']);
  await page.goto('/workflows');
  await expect(page.getByTestId('delete-workflow-lfg')).toHaveCount(0);
  await page.getByTestId(`delete-workflow-${flow.id}`).click();
  const dialog = page.getByTestId('delete-dialog');
  await expect(dialog.getByRole('heading', { level: 2 })).toHaveText(`删除 workflow ${flow.name}`);
  await expect(dialog).toContainText('一起删除它的 2 个 variant');
  await expect(dialog.getByTestId('delete-dirs').locator('li')).toHaveCount(2);
  // 改绑的目标中没有要删除的 variant
  const options = await dialog
    .getByTestId('delete-rebind-target')
    .locator('option')
    .allTextContents();
  expect(options).not.toContain('另一个');
  await dialog.getByTestId('delete-confirm-name').fill(flow.name);
  await shoot(page, 'delete-workflow');
  await dialog.getByTestId('delete-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId(`workflow-row-${flow.id}`)).toHaveCount(0);
});
