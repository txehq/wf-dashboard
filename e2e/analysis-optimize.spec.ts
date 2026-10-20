import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './test.js';
import { api, seeded, shots, sizes } from './analysis-helpers.js';

// 优化（Contracts 19.3、22）：选 Claude Code，会话在分析目录中（Claude Code 是回显按键的替身）；测试代码代替它
// 改 skill，保存与 Codex 相同
test.describe.configure({ mode: 'serial' });
test.setTimeout(180_000);

test('优化：选引擎（默认 Codex，选 Claude Code），跳到 Live 的 Claude Code 项，准备完成后保存为原 workflow 的新 variant', async ({
  page,
  request,
}) => {
  const id = await seeded(request);
  await page.goto(`/analyses/${id}`);
  await page.getByTestId('analysis-optimize').click();
  const choice = page.getByTestId('engine-choice');
  await expect(choice).toHaveAttribute('data-engine', 'codex');
  await expect(choice.getByRole('radio')).toHaveText(['Codex', 'Claude Code']);
  await expect(choice.getByTestId('live-engine-logo')).toHaveCount(2);
  await choice.getByRole('radio', { name: 'Claude Code' }).click();
  await expect(choice).toHaveAttribute('data-engine', 'claude');
  for (const size of sizes) {
    await page.setViewportSize(size);
    await choice.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${shots}/w59-optimize-engine-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }
  await page.getByTestId('analysis-optimize-start').click();
  await expect(page).toHaveURL(/\/live\?item=l-\d{8}-[a-z0-9]{6}$/);
  const liveId = new URL(page.url()).searchParams.get('item') ?? '';
  const panel = page.getByTestId('live-panel');
  await expect(panel.getByTestId('live-engine')).toHaveText('Claude Code');
  // 下面一行有对应的分析，工具栏中有保存（Contracts 26.1）
  await expect(panel.getByTestId('codex-draft-analysis')).toHaveText(`分析 ${id}`);
  const save = panel.getByTestId('live-toolbar').getByTestId('codex-draft-save');
  await expect(save).toHaveText('保存');
  await expect(save).toBeEnabled({ timeout: 120_000 });
  // 终端中是 Claude Code（替身）在分析目录中运行
  await expect(page.locator('.xterm-rows')).toContainText('Claude Code 替身', { timeout: 30_000 });
  await expect(
    page.locator(`[data-live="${liveId}"] [data-testid="live-engine-logo"]`).first(),
  ).toHaveAttribute('data-engine', 'claude');
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.screenshot({
      path: `${shots}/w59-optimize-claude-live-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }

  // 测试代码代替 agent 在 optimize/src 中改一个 skill；optimize/workflow.yaml 不变，保存为新 variant
  const detail = (await (await request.get(`${api}/analyses/${id}`)).json()) as {
    optimizeDrafts: { id: string }[];
  };
  const draftId = detail.optimizeDrafts.at(-1)?.id ?? '';
  const draft = (await (await request.get(`${api}/workflow-drafts/${draftId}`)).json()) as {
    dir: string;
    engine: string;
  };
  expect(draft.engine).toBe('claude');
  expect(draft.dir).toMatch(new RegExp(`/analyses/${id}$`));
  expect(fs.existsSync(path.join(draft.dir, '.claude/skills/optimize-from-report/SKILL.md'))).toBe(
    true,
  );
  fs.appendFileSync(
    path.join(draft.dir, 'optimize/src/skills/remember/SKILL.md'),
    '\n记住后只回答"记住了"。\n',
  );
  // workflow 面板（Contracts 26.2、26.3）：读 optimize/ 下的文件，顶部链接到分析报告，改动在 1 秒内标出
  const workspace = page.getByTestId('workflow-panel');
  await expect(workspace).toContainText('optimize/src/skills');
  await expect(workspace.getByTestId('ws-analysis-link')).toHaveAttribute(
    'href',
    `/analyses/${id}`,
  );
  await expect(
    workspace.locator('[data-testid="ws-file"][data-path="skills/remember/SKILL.md"]'),
  ).toHaveAttribute('data-status', 'modified', { timeout: 1_000 });
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
  await expect(panel.getByTestId('codex-draft-saved')).toHaveCount(0);
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
  // 保存来源按草稿的引擎写（Contracts 28.4）
  await expect(page.getByTestId('variant-draft')).toHaveText(`来自 Claude Code 草稿 ${draftId}`);
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.screenshot({
      path: `${shots}/w83-claude-draft-source-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }
  const result = (await (await request.get(`${api}/workflow-drafts/${draftId}`)).json()) as {
    savedWorkflowId: string;
  };
  expect(result.savedWorkflowId).toBe('secret-keeper');

  // 结束这一项的 Claude Code 进程（替身）
  const stopped = await request.post(`${api}/live/${liveId}/stop`);
  expect([200, 409]).toContain(stopped.status());
});
