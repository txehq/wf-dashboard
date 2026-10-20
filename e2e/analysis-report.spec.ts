import { expect, test } from './test.js';
import { checkContrast } from './contrast.js';
import { aspects, seeded, session, shots } from './analysis-helpers.js';

// 新建分析时选分析方法、报告页的方面分组，以及分析列表、报告页与修改建议的对比度
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

test('新建分析时选用哪个 session-analysis 的 variant：默认基线，可以选派生的分析方法', async ({
  page,
}) => {
  await page.goto(`/analyses/new?sessions=${session}`);
  const form = page.getByTestId('analysis-settings');
  await expect(form.getByTestId('picked-item')).toHaveCount(1);
  await expect(form.getByTestId('scope-variant')).toHaveText('初稿');
  const select = form.getByTestId('analysis-variant');
  await expect(select.locator('option')).toHaveText(['只看失败', '基线（默认）']);
  await expect(select.locator('option:checked')).toHaveText('基线（默认）');
  await select.selectOption({ label: '只看失败' });
  await page.screenshot({ path: `${shots}/w45-new-analysis.png`, animations: 'disabled' });
  await form.getByRole('button', { name: '开始分析' }).click();

  await expect(page).toHaveURL(/\/analyses\/a-\d{8}-[a-z0-9]{6}$/);
  await expect(page.getByTestId('analysis-method')).toHaveText('只看失败');
  // 步骤即 session-analysis 的小阶段（基础档中引擎失败，这里只看步骤与所选的方法）
  const steps = page.getByTestId('analysis-step');
  await expect(steps).toHaveCount(10);
  await expect(steps.first()).toContainText('流程遵守');
  await expect(steps.last()).toContainText('综合：报告与修改建议');
});

test('报告页：报告的总结与结果、按九个方面分组的发现、需要新建 workflow 的建议', async ({
  page,
  request,
}) => {
  const id = await seeded(request);
  await page.goto(`/analyses/${id}`);
  const report = page.getByTestId('analysis-report');
  await expect(report).toContainText('agent 照做了');
  await expect(report.getByTestId('analysis-outcome')).toHaveText('完成');
  await expect(report.getByTestId('workflow-changes')).toContainText('去掉小阶段 remember');
  await expect(page.getByTestId('analysis-method')).toHaveText('基线');
  for (const [key, name] of aspects) {
    const section = page.getByTestId(`aspect-${key}`);
    await expect(section.getByRole('heading', { level: 3 })).toContainText(name);
    await expect(section.getByTestId('finding')).toHaveCount(1);
  }
  await expect(page.getByTestId('aspect-process-adherence')).toContainText(
    'remember · skill secret-keeper',
  );
  await page.screenshot({
    path: `${shots}/w45-report.png`,
    fullPage: true,
    animations: 'disabled',
  });
});

test('对比度：分析列表、报告页与修改建议（统一、并排、渲染后的对比）达到 WCAG AA，明暗两种主题', async ({
  page,
  request,
}) => {
  await page.goto('/analyses');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Analyses');
  await checkContrast(page, 'analyses-list', { screenshot: true });

  const id = await seeded(request);
  await page.goto(`/analyses/${id}`);
  await expect(page.getByTestId('analysis-report')).toContainText('agent 照做了');
  const review = page.getByTestId('patch-review');
  await expect(review.getByTestId('hunk')).toHaveCount(4);
  await checkContrast(page, 'analysis-report', { screenshot: true });
  await review.getByTestId('diff-view-type').getByRole('button', { name: '并排' }).click();
  await expect(review.locator('table.diff-split').first()).toBeVisible();
  await checkContrast(page, 'analysis-diff-split');
  await review.getByTestId('diff-view-type').getByRole('button', { name: '统一' }).click();
  await review.getByRole('button', { name: '渲染后的对比' }).click();
  await expect(review.getByTestId('rendered-compare')).toBeVisible();
  await checkContrast(page, 'analysis-rendered-compare', { screenshot: true });
});
