import { expect, test } from '@playwright/test';
import { analysesServerPort } from '../ports.js';

// 数据由 prepare-analyses-e2e 每次重建：dqva52（lfg）与 27yz3d（ic）两个真实 run 的 session，以本机来源导入，
// 与 txe-workflow 9f2bed6 的基线逐字节一致而自动绑定。分析用真实的 Claude Code 引擎（models.judge）
const api = `http://127.0.0.1:${String(analysesServerPort)}/api`;
const shots = '.work/screenshots';
const icSession = '70e7a9b6-fdad-44c3-9b65-015ee2a0499c';
const lfgSession = '0188c133-3e7b-4592-a963-fc717cf283de';
const baseline = '基线 9f2bed6';

interface Hunk {
  index: number;
  start: number;
  insert: string[];
  remove: string[];
}
interface Detail {
  status: string;
  findings: { findingId: string; evidence: { sessionId: string; seq: number }[] }[];
  files: { path: string; original: string; hunks: Hunk[] }[];
}

test('Sessions 中的绑定：两个 session 自动绑定到基线，详情显示方式与加载过的 skill', async ({
  page,
}) => {
  await page.goto('/sessions');
  for (const id of [icSession, lfgSession]) {
    const row = page.getByTestId('session-row').filter({ hasText: id.slice(0, 8) });
    await expect(row.getByTestId('session-variant')).toContainText(baseline);
    await expect(row.getByTestId('session-variant')).toContainText('自动');
  }
  await page.screenshot({ path: `${shots}/w31-sessions-list.png`, animations: 'disabled' });
  await page.goto(`/sessions/${icSession}`);
  const binding = page.getByTestId('session-binding');
  await expect(binding.getByTestId('binding-variant')).toContainText(baseline);
  await expect(binding.getByTestId('binding-kind')).toHaveText('自动');
  await expect(binding).toContainText(
    '加载过的 skill：ic、claim、readiness、implement、open-pr、review-pr',
  );
  await binding.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/w31-sessions-binding.png`, animations: 'disabled' });
});

test('新建分析、报告、证据链接、按 hunk 接受与拒绝、编辑后另存为 variant', async ({
  page,
  request,
}) => {
  test.setTimeout(40 * 60_000);
  // 从 Sessions 列表多选进入新建表单
  await page.goto('/sessions');
  await page.getByRole('checkbox', { name: `选择 session ${icSession.slice(0, 8)}` }).check();
  await page.getByRole('link', { name: '分析这些 session' }).click();
  await expect(page).toHaveURL(new RegExp(`/analyses/new\\?sessions=${icSession}$`));
  const form = page.getByRole('form', { name: '新建分析' });
  await expect(form.getByTestId('scope-variant')).toHaveText(baseline);
  await expect(form.getByTestId('scope-sessions').getByRole('listitem')).toHaveCount(1);
  await expect(form.getByTestId('scope-sessions')).toContainText('/ic TXE-3767');
  await expect(form.getByRole('radio', { name: /Claude Code/ })).toBeChecked();
  await expect(form.getByRole('textbox', { name: '模型' })).not.toHaveValue('');
  await page.screenshot({ path: `${shots}/w31-new-analysis.png`, animations: 'disabled' });
  await form.getByRole('button', { name: '开始分析' }).click();

  await expect(page).toHaveURL(/\/analyses\/a-\d{8}-[a-z0-9]{6}$/);
  const id = page.url().split('/').pop() ?? '';
  await expect(page.getByTestId('analysis-status')).toHaveText('已完成', { timeout: 35 * 60_000 });
  for (const aspect of ['process', 'efficiency', 'interaction', 'quality']) {
    await expect(page.getByTestId(`aspect-${aspect}`)).toBeVisible();
  }
  const detail = (await (await request.get(`${api}/analyses/${id}`)).json()) as Detail;
  expect(detail.findings.length).toBeGreaterThan(0);
  expect(detail.files.length).toBeGreaterThan(0);
  await page.screenshot({
    path: `${shots}/w31-report.png`,
    fullPage: true,
    animations: 'disabled',
  });

  // 证据链接跳到 Sessions 详情中对应的请求
  const link = page.getByTestId('evidence-link').first();
  const href = (await link.getAttribute('href')) ?? '';
  const seq = Number(new URL(href, 'http://x').searchParams.get('seq'));
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${icSession}\\?seq=${String(seq)}$`));
  const focused = page.locator('[data-testid="request-row"][data-focused="true"]');
  await expect(focused).toHaveCount(1);
  await expect(focused).toContainText(`#${String(seq)}`);
  await expect(focused).toBeInViewport();
  await page.goBack();

  // 第一个文件：接受第一处插入了文字的修改，拒绝其余；再在编辑器中改一处
  const file = detail.files[0];
  if (file === undefined) throw new Error('没有修改建议');
  const pick = file.hunks.findIndex((h) => h.insert.some((l) => l.trim() !== ''));
  const accepted = file.hunks[pick];
  if (accepted === undefined) throw new Error(`${file.path} 的修改都没有插入文字`);
  const review = page.getByTestId('patch-review');
  await review.getByRole('tab', { name: new RegExp(file.path) }).click();
  const hunks = review.getByTestId('hunk');
  await expect(hunks).toHaveCount(file.hunks.length);
  for (let i = 0; i < file.hunks.length; i += 1) {
    const decision = i === pick ? 'accepted' : 'rejected';
    await hunks
      .nth(i)
      .getByRole('button', { name: i === pick ? '接受' : '拒绝' })
      .click();
    await expect(hunks.nth(i)).toHaveAttribute('data-decision', decision);
  }
  await expect(review.getByTestId('changed-files')).toContainText('1 个文件有修改');
  // 在结果一侧接受的文字所在的行末加一段文字（Monaco 把空格渲染为不换行空格）
  const insertedLine = accepted.insert.find((l) => l.trim() !== '') ?? '';
  const probe = insertedLine
    .trim()
    .slice(0, 24)
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/ /g, '\\s');
  await review
    .locator('.editor.modified .view-line')
    .filter({ hasText: new RegExp(probe) })
    .first()
    .click();
  await page.keyboard.press('End');
  await page.keyboard.type(' e2e-edit');
  await expect(review).toContainText('已在编辑器中修改');
  await expect(hunks.nth(pick).getByRole('button', { name: '接受' })).toBeDisabled();
  await page.screenshot({ path: `${shots}/w31-diff.png`, animations: 'disabled' });

  const name = `w31 e2e ${id}`;
  await review.getByLabel('新 variant 的名称').fill(name);
  await review.getByRole('button', { name: '另存为 variant' }).click();
  // 新 variant 在所属 workflow 的页面中展开（Contracts 16.7）
  await expect(page).toHaveURL(/\/workflows\/[a-z0-9-]+\?variant=[0-9a-f-]{36}$/);
  const variantId = new URL(page.url()).searchParams.get('variant') ?? '';
  const panel = page.getByTestId('variant-panel');
  await expect(panel.getByRole('heading', { level: 2 })).toContainText(name);
  await expect(panel.getByTestId('variant-analysis')).toContainText(id);
  await expect(panel.getByTestId('variant-parent')).toContainText(baseline);
  await page.screenshot({ path: `${shots}/w31-variant.png`, animations: 'disabled' });

  // 新 variant 的 src/skills：第一处接受的修改与编辑都在，拒绝的不在；状态为草稿，记录了 parent 与 analysis_id
  const variant = (await (await request.get(`${api}/variants/${variantId}`)).json()) as {
    status: string;
    buildStatus: string;
    parentId: string;
    analysisId: string;
  };
  expect(variant).toMatchObject({ status: 'draft', buildStatus: 'none', analysisId: id });
  const saved = (
    (await (
      await request.get(`${api}/variants/${variantId}/file?path=${encodeURIComponent(file.path)}`)
    ).json()) as { content: string }
  ).content;
  expect(saved).toContain(' e2e-edit');
  expect(saved.replace(' e2e-edit', '')).toBe(applyOne(file.original, accepted));
  for (const h of file.hunks.filter((_, i) => i !== pick)) {
    const added = h.insert.join('');
    if (added.trim() !== '' && !file.original.includes(added)) expect(saved).not.toContain(added);
  }
});

// 只应用一处改动：原文第 start 行起删除 remove，插入 insert
function applyOne(original: string, hunk: Hunk): string {
  const lines = original.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  return [
    ...lines.slice(0, hunk.start),
    ...hunk.insert,
    ...lines.slice(hunk.start + hunk.remove.length),
  ].join('');
}
