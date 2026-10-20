import { rmSync } from 'node:fs';
import path from 'node:path';
import { expect, type Page, test } from './test.js';

const shot = (page: Page, name: string) =>
  page.screenshot({
    path: `.work/screenshots/w5-${name}.png`,
    fullPage: true,
    animations: 'disabled',
  });
// 编辑保存用测试自己新建的 task，结束后删除目录，tasks/ 中的自带 task 不受影响
const editId = `e2e-${String(Date.now())}`;

test.afterAll(() => {
  rmSync(path.join('tasks', editId), { recursive: true, force: true });
});

test('Tasks 列表按 lfg 与 ic 分组显示 7 个自带 task', async ({ page }) => {
  await page.goto('/tasks');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tasks');
  const lfg = page.locator('[data-slot=card]', { hasText: '/lfg' });
  const ic = page.locator('[data-slot=card]', { hasText: '/ic' });
  await expect(lfg.getByRole('link')).toHaveText([
    '课堂用的网页计算器',
    '按拍摄日期整理照片的命令行工具',
    '移动 App 用的待办清单 HTTP API',
  ]);
  await expect(ic.getByRole('link')).toHaveText([
    '金额格式化：按币种小数位、负数与大金额',
    'TaskStore 增加带筛选、排序与分页的 list',
    '单位换算页面：温度、结果精度、输入提示与交换单位',
    'wrap 命令行工具：段落、长单词与参数校验',
  ]);
  await expect(lfg).toContainText('做一个计算器');
  await expect(ic).toContainText('38 个隐藏测试');
  await shot(page, 'list');

  await ic.getByRole('link', { name: /^wrap/ }).click();
  await expect(page).toHaveURL(/\/tasks\/ic-wrap-cli$/);
  await expect(page.getByLabel('工单标题')).toHaveValue(
    'wrap 撑破长单词、合并段落，命令行参数不校验',
  );
  await expect(page.getByText('38 个隐藏测试')).toBeVisible();
  await shot(page, 'ic-detail');
});

test('新建 lfg task，编辑 persona 与 rubric 条目后保存，刷新后仍在', async ({ page }) => {
  await page.goto('/tasks/new');
  await page.getByLabel('ID').fill(editId);
  await page.getByLabel('标题').fill('家庭记账本');
  await page.getByLabel('交给 /lfg 的输入').fill('做一个记账本');
  await page
    .getByLabel('Persona（模拟用户扮演的人）')
    .fill('赵敏，两个孩子的妈妈，想记清每月开销。');
  await page.getByLabel('隐藏需求（只在被问到时透露）').fill('- 手机网页\n- 按月汇总');

  // 规则校验：空的判定标准不能创建
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page.getByTestId('form-issues')).toContainText('rubric');

  for (const artifact of ['brief', 'research', 'plan', 'tickets']) {
    await page
      .getByTestId(`rubric-${artifact}`)
      .getByRole('textbox', { name: /第 1 条的判定标准/ })
      .fill(`${artifact} 是否写明按月汇总`);
  }
  await page.getByRole('button', { name: '创建' }).click();
  await expect(page).toHaveURL(new RegExp(`/tasks/${editId}$`));

  await page.getByLabel('Persona（模拟用户扮演的人）').fill('赵敏，两个孩子的妈妈，只用手机。');
  const brief = page.getByTestId('rubric-brief');
  await brief.getByRole('button', { name: '添加条目' }).click();
  await brief
    .getByRole('textbox', { name: 'Brief 第 2 条的判定标准' })
    .fill('Brief 是否写明只用手机');
  await brief.getByRole('spinbutton', { name: 'Brief 第 2 条的满分' }).fill('4');
  await expect(page.getByTestId('save-status')).toHaveText('有未保存的修改');
  await expect(page.getByTestId('rubric-total')).toHaveText('满分合计 16');
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByTestId('save-status')).toHaveText(`已保存到 tasks/${editId}/task.yaml`);
  await shot(page, 'edit-saved');

  await page.reload();
  await expect(page.getByLabel('Persona（模拟用户扮演的人）')).toHaveValue(
    '赵敏，两个孩子的妈妈，只用手机。',
  );
  await expect(brief.getByRole('textbox', { name: 'Brief 第 2 条的判定标准' })).toHaveValue(
    'Brief 是否写明只用手机',
  );
  await expect(page.getByTestId('rubric-total')).toHaveText('满分合计 16');
});

test('让 LLM 起草 rubric：显示草稿，采纳后替换表单中的 rubric', async ({ page }) => {
  test.setTimeout(240_000);
  await page.goto('/tasks/lfg-calculator');
  await expect(page.getByLabel('交给 /lfg 的输入')).toHaveValue('做一个计算器');
  await page.getByRole('button', { name: '让 LLM 起草 rubric' }).click();
  await expect(page.getByRole('button', { name: '起草中，约需 30 秒…' })).toBeDisabled();
  const draft = page.getByTestId('rubric-draft');
  await expect(draft).toBeVisible({ timeout: 200_000 });
  await expect(draft).toContainText('LLM 草稿');
  for (const label of ['Brief', 'Research', 'Plan', 'Tickets']) {
    await expect(draft.getByRole('heading', { name: new RegExp(`^${label}（满分`) })).toBeVisible();
  }
  await shot(page, 'rubric-draft');

  const draftedFirst = await draft.locator('tbody tr').first().locator('td').nth(1).innerText();
  await draft.getByRole('button', { name: '采纳草稿' }).click();
  await expect(draft).toBeHidden();
  await expect(page.getByTestId('save-status')).toHaveText('有未保存的修改');
  await expect(
    page.getByTestId('rubric-brief').getByRole('textbox', { name: 'Brief 第 1 条的判定标准' }),
  ).toHaveValue(draftedFirst);
  await shot(page, 'rubric-adopted');
  // 不保存：自带的 lfg-calculator 保持原样
});
