import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './test.js';
import { analysisWorkflowServerPort } from '../ports.js';

// 分析由 workflow session-analysis 驱动（Contracts 19.2、19.3），基础档：数据由 prepare-analysis-workflow-e2e 每次重建
// （一轮的短 session cfa31f10 绑定到 workflow secret-keeper 的初稿，session-analysis 的基线与派生的"只看失败"，
// 一次成功的分析作为测试数据）。服务端不调用模型；Codex 是替身命令，skill 来源是本地 git 仓库
const api = `http://127.0.0.1:${String(analysisWorkflowServerPort)}/api`;
const shots = '.work/screenshots';
// 两种窗口下截图自查（Contracts 20.4）
const sizes = [
  { width: 1280, height: 800 },
  { width: 1600, height: 1000 },
] as const;
const session = 'cfa31f10-e280-4908-bcf7-cbe9b00fbe53';
const aspects = [
  ['process-adherence', '流程遵守'],
  ['plan-adherence', '计划遵守'],
  ['failures', '经常失败的地方'],
  ['repeated-work', '重复的工作'],
  ['token-waste', '浪费 token'],
  ['time-waste', '浪费时间'],
  ['user-interaction', '和用户的交互'],
  ['output-quality', '产物质量'],
  ['request-conflicts', '与请求的冲突'],
] as const;

interface Summary {
  id: string;
  status: string;
  analysisVariantName: string | null;
}

test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

// 测试数据中的那次成功的分析
async function seeded(request: import('@playwright/test').APIRequestContext): Promise<string> {
  const list = (await (await request.get(`${api}/analyses`)).json()) as Summary[];
  const found = list.find((a) => a.status === 'succeeded');
  if (found === undefined) throw new Error('测试数据中没有成功的分析');
  return found.id;
}

test('新建分析时选用哪个 session-analysis 的 variant：默认基线，可以选派生的分析方法', async ({
  page,
}) => {
  await page.goto(`/analyses/new?sessions=${session}`);
  const form = page.getByRole('form', { name: '新建分析' });
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

test('修改建议：红绿 diff、统一与并排、展开未改动的行、按 hunk 接受与拒绝、渲染后的对比、编辑结果、另存为 variant', async ({
  page,
  request,
}) => {
  const id = await seeded(request);
  const detail = (await (await request.get(`${api}/analyses/${id}`)).json()) as {
    files: { path: string; original: string; hunks: { start: number; insert: string[] }[] }[];
  };
  const file = detail.files[0];
  if (file === undefined) throw new Error('测试数据中没有修改建议');
  expect(file.path).toBe('skills/remember/SKILL.md');
  expect(file.hunks.length).toBe(4);

  await page.goto(`/analyses/${id}`);
  const review = page.getByTestId('patch-review');
  await review.scrollIntoViewIfNeeded();
  const hunks = review.getByTestId('hunk');
  await expect(hunks).toHaveCount(4);
  await expect(hunks.first()).toContainText(`第 ${String((file.hunks[0]?.start ?? 0) + 1)} 行`);
  await expect(hunks.first().getByRole('link', { name: 'process-adherence-1' })).toBeVisible();

  // 统一：新增的行绿底、行首 +，删除的行红底、行首 -，两侧行号
  const toggle = review.getByTestId('diff-view-type');
  await expect(toggle).toHaveAttribute('data-view', 'unified');
  const inserted = review.locator('td.diff-code-insert');
  const deleted = review.locator('td.diff-code-delete');
  await expect(inserted).toHaveCount(4);
  await expect(deleted).toHaveCount(2);
  const style = (locator: typeof inserted) =>
    locator.first().evaluate((el) => ({
      background: getComputedStyle(el).backgroundColor,
      sign: getComputedStyle(el, '::before').content,
    }));
  expect(await style(inserted)).toEqual({ background: 'rgb(230, 255, 236)', sign: '"+"' });
  expect(await style(deleted)).toEqual({ background: 'rgb(255, 235, 233)', sign: '"-"' });
  // 行内改动的词加深
  await expect(inserted.first().locator('.diff-code-edit')).toHaveText(
    ', in the language of the request',
  );
  const firstDeleted = review.locator('tr.diff-line', { has: page.locator('td.diff-code-delete') });
  await expect(firstDeleted.first().locator('td.diff-gutter')).toHaveText(['9', '']);
  await review.scrollIntoViewIfNeeded();
  for (const size of sizes) {
    await page.setViewportSize(size);
    await review.getByTestId('patch-work').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${shots}/w50-analysis-diff-unified-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }

  // 并排：删除在左、新增在右；刷新后保持
  await toggle.getByRole('button', { name: '并排' }).click();
  await expect(review.locator('table.diff-split')).toBeVisible();
  await expect(
    review
      .locator('tr.diff-line', { has: page.locator('td.diff-code-delete') })
      .first()
      .locator('td.diff-code-insert'),
  ).toContainText('in the language of the request');
  await page.reload();
  await expect(toggle).toHaveAttribute('data-view', 'split');
  await expect(review.locator('table.diff-split')).toBeVisible();
  await expect(hunks).toHaveCount(4);
  for (const size of sizes) {
    await page.setViewportSize(size);
    await review.getByTestId('patch-work').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${shots}/w50-analysis-diff-split-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }
  await toggle.getByRole('button', { name: '统一' }).click();
  await expect(review.locator('table.diff-unified')).toBeVisible();

  // 没有改动的长段折叠，点击展开
  const lines = review.locator('tr.diff-line');
  const before = await lines.count();
  const expand = review.getByTestId('diff-expand').filter({ hasText: /展开 \d{2} 行未改动/ });
  const hidden = Number(/展开 (\d+) 行/.exec((await expand.first().textContent()) ?? '')?.[1]);
  await expand.first().click();
  await expect(lines).toHaveCount(before + hidden);

  // 按 hunk 接受与拒绝
  await hunks.nth(0).getByRole('button', { name: '接受' }).click();
  await hunks.nth(1).getByRole('button', { name: '拒绝' }).click();
  await expect(hunks.nth(0)).toHaveAttribute('data-decision', 'accepted');
  await expect(hunks.nth(1)).toHaveAttribute('data-decision', 'rejected');
  await expect(review.getByTestId('changed-files')).toContainText('1 个文件有修改');
  await expect(review.getByRole('tab', { name: /remember\/SKILL\.md/ })).toContainText('2/4');

  // 渲染后的对比：左右两份渲染的 Markdown，改动的段落标出，滚动同步
  await review.getByRole('button', { name: '渲染后的对比' }).click();
  const compare = review.getByTestId('rendered-compare');
  const left = compare.locator('[data-side="original"]');
  const right = compare.locator('[data-side="modified"]');
  await expect(left.locator('table.frontmatter th')).toHaveText(['name', 'description']);
  await expect(left.locator('.md-mark-removed')).toHaveText([
    /^The user gives a passphrase once\..*they asked for\.$/s,
    /Never translate it\.$/,
  ]);
  await expect(right.locator('.md-mark-added')).toHaveText([
    /in the language of the request\.$/,
    'Anything elseNothing about the passphrase',
    'Call the remember skill before replying',
    /never shorten it\.$/,
  ]);
  await expect(right.locator('pre code.hljs.language-ts .hljs-keyword').first()).toHaveText(
    'const',
  );
  expect(
    await right
      .locator('ol')
      .first()
      .evaluate((el) => getComputedStyle(el).listStyleType),
  ).toBe('decimal');
  await expect(left.getByTestId('mermaid').locator('svg')).toBeVisible();
  await expect(right.getByTestId('mermaid').locator('svg')).toBeVisible();
  for (const size of sizes) {
    await page.setViewportSize(size);
    await review.getByTestId('patch-work').scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${shots}/w50-analysis-rendered-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }
  await right.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect
    .poll(() => left.evaluate((el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 2))
    .toBe(true);

  // 全屏：铺满窗口，写进地址
  await review.getByTestId('fullscreen-toggle').click();
  await expect(review).toHaveAttribute('data-fullscreen', 'true');
  await expect(page).toHaveURL(/fullscreen=1/);
  expect(await review.evaluate((el) => el.getBoundingClientRect().width)).toBe(sizes[1].width);
  await review.getByTestId('fullscreen-toggle').click();
  await expect(review).toHaveAttribute('data-fullscreen', 'false');

  // 编辑结果：Monaco 对比视图中是接受的那一处，颜色与 diff 相同
  await review.getByRole('button', { name: '编辑结果' }).click();
  const editor = review.getByTestId('patch-editor');
  await expect(editor.locator('.editor.modified')).toContainText('in the language of the request');
  await expect(editor.locator('.editor.modified')).not.toContainText('Anything else');
  await expect
    .poll(() =>
      editor
        .locator('.editor.modified .line-insert')
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    )
    .toBe('rgb(230, 255, 236)');
  await expect
    .poll(() =>
      editor
        .locator('.editor.original .line-delete')
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor),
    )
    .toBe('rgb(255, 235, 233)');
  await page.screenshot({ path: `${shots}/w50-analysis-edit.png`, animations: 'disabled' });

  const name = `w50 e2e ${id}`;
  await review.getByLabel('新 variant 的名称').fill(name);
  // 名字与描述都必填（Contracts 19.3）
  const saveAs = review.getByRole('button', { name: '另存为 variant' });
  await expect(saveAs).toBeDisabled();
  await review.getByLabel('新 variant 的描述').fill('按请求的语言回答');
  await saveAs.click();
  await expect(page).toHaveURL(/\/variants\/[0-9a-f-]{36}$/);
  // 另存不构建
  await expect(page.getByTestId('build-status')).toHaveText('未构建');
  const variantId = page.url().split('/').at(-1) ?? '';
  const saved = (
    (await (
      await request.get(`${api}/variants/${variantId}/file?path=${encodeURIComponent(file.path)}`)
    ).json()) as { content: string }
  ).content;
  expect(saved).toBe(
    file.original.replace(
      'answer with the single word they asked for.',
      'answer with the single word they asked for, in the language of the request.',
    ),
  );
});

test('交给 Codex 优化：跳到 Live 的 Codex 项，准备完成后保存为原 workflow 的新 variant', async ({
  page,
  request,
}) => {
  const id = await seeded(request);
  await page.goto(`/analyses/${id}`);
  await page.getByTestId('analysis-optimize').click();
  await expect(page).toHaveURL(/\/live\?item=l-\d{8}-[a-z0-9]{6}$/);
  const liveId = new URL(page.url()).searchParams.get('item') ?? '';
  const bar = page.getByTestId('codex-draft-bar');
  await expect(bar).toContainText(`分析 ${id}`);
  const save = bar.getByTestId('codex-draft-save');
  await expect(save).toHaveText('保存');
  await expect(save).toBeEnabled({ timeout: 120_000 });
  await page.screenshot({ path: `${shots}/w45-codex-optimize.png`, animations: 'disabled' });

  // 测试代码代替 Codex 在 optimize/src 中改一个 skill；optimize/workflow.yaml 不变，保存为新 variant
  const detail = (await (await request.get(`${api}/analyses/${id}`)).json()) as {
    optimizeDrafts: { id: string }[];
  };
  const draftId = detail.optimizeDrafts.at(-1)?.id ?? '';
  const draft = (await (await request.get(`${api}/workflow-drafts/${draftId}`)).json()) as {
    dir: string;
  };
  expect(draft.dir).toMatch(new RegExp(`/analyses/${id}$`));
  fs.appendFileSync(
    path.join(draft.dir, 'optimize/src/skills/remember/SKILL.md'),
    '\n记住后只回答"记住了"。\n',
  );
  await save.click();
  // 保存对话框（Contracts 19.3、17.4）：optimize/workflow.yaml 没有改，保存到原 workflow；默认新建，
  // 预览为 optimize/src 相对被分析的 variant 的 diff
  const dialog = page.getByTestId('codex-save-dialog');
  await expect(dialog).toContainText('保存到 workflow');
  await expect(dialog.getByTestId('codex-save-kind-new')).toBeChecked();
  await expect(dialog.getByTestId('codex-save-against')).toHaveText('相对底子 初稿');
  const changed = dialog.getByTestId('diff-file');
  await expect(changed).toHaveCount(1);
  await expect(changed).toHaveAttribute('data-path', 'skills/remember/SKILL.md');
  await expect(changed.getByTestId('diff-counts')).toHaveText('+2 −0');
  await expect(changed.locator('td.diff-code-insert')).toHaveText(['', '记住后只回答"记住了"。']);
  await expect(changed.locator('td.diff-code-delete')).toHaveCount(0);
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.screenshot({
      path: `${shots}/w50-codex-save-preview-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }
  // 取消后没有保存
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(bar.getByTestId('codex-draft-saved')).toHaveCount(0);
  await save.click();
  // 名字与描述都必填
  await expect(dialog.getByTestId('codex-save-confirm')).toBeDisabled();
  await dialog.getByTestId('codex-save-name').fill(`只答记住了 ${id}`);
  await dialog.getByTestId('codex-save-description').fill('记住后只回答"记住了"');
  await dialog.getByTestId('codex-save-confirm').click();
  // 保存不构建：跳到 variant 页面，显示未构建
  await expect(page).toHaveURL(/\/variants\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('build-status')).toHaveText('未构建');
  await expect(page.getByTestId('variant-analysis')).toContainText(id);
  await page.screenshot({ path: `${shots}/w52-optimize-saved.png`, animations: 'disabled' });
  const result = (await (await request.get(`${api}/workflow-drafts/${draftId}`)).json()) as {
    savedWorkflowId: string;
  };
  expect(result.savedWorkflowId).toBe('secret-keeper');

  // 结束这一项的 Codex 进程（替身）
  const stopped = await request.post(`${api}/live/${liveId}/stop`);
  expect([200, 409]).toContain(stopped.status());
});
