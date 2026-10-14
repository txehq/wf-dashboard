import { expect, test } from './test.js';
import { api, seeded, shots, sizes } from './analysis-helpers.js';

// 分析报告中的修改建议（Contracts 21.3）：红绿 diff、接受与拒绝、渲染后的对比、编辑结果与另存
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

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
