import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { stringify } from 'yaml';
import { serverPort } from '../ports.js';

// 用 Codex 生成 workflow 或 variant（Contracts 第 17 节）：两个入口的表单、跳到 Live 的 Codex 会话、保存按钮。
// 服务端的 Codex 是测试中的替身命令（e2e/services.ts），只验证页面与 API，不验证 Codex 本身；skill 来源是本地仓库。
// 新 workflow 的草稿从空白骨架开始，保存时用自有管理器构建（Contracts 18.5、18.6），很快，在基础档
const api = `http://127.0.0.1:${String(serverPort)}/api`;
const marker = randomUUID().slice(0, 6);
const root = path.resolve(import.meta.dirname, '..');
const example = path.join(root, 'server/src/drafts/assets/simple-workflow');

interface Variant {
  id: string;
  name: string;
  workflowId: string;
}
interface Draft {
  id: string;
  dir: string;
  liveId: string;
  status: string;
}

// 导入基线要从 txe-workflow 复制 src/；发起时复制 src 与装 skill
test.setTimeout(300_000);
test.describe.configure({ mode: 'serial' });

let base: Variant;

test.beforeAll(async ({ request }) => {
  const created = await request.post(`${api}/variants`, {
    data: { name: `e2e 草稿底子 ${marker}` },
  });
  expect(created.status()).toBe(201);
  base = (await created.json()) as Variant;
});

// xterm.js 的 DOM 渲染用不换行空格
const terminalText = async (page: Page) =>
  ((await page.locator('.xterm-rows').textContent()) ?? '').replaceAll(' ', ' ');

// 结束这一项的 Codex 进程（替身），测试结束后不留运行中的进程
async function stopLive(page: Page, liveId: string) {
  const response = await page.request.post(`${api}/live/${liveId}/stop`);
  expect([200, 409]).toContain(response.status());
}

test('用 Codex 生成 workflow：表单、跳到 Live 的 Codex 会话、保存失败时显示原文', async ({
  page,
}) => {
  const workflowId = `hello-${marker}`;
  await page.goto('/workflows');
  await page.getByTestId('codex-workflow-toggle').click();
  const form = page.getByTestId('codex-draft-workflow');
  await expect(form.getByRole('heading')).toHaveText('用 Codex 生成 workflow');
  await form.getByLabel('id（入口命令 /id）').fill(workflowId);
  await form.getByLabel('名字').fill(`你好 ${marker}`);
  // 从空白骨架开始：没有底子 variant
  await expect(form.getByTestId('codex-draft-base')).toHaveCount(0);
  await form.getByLabel('描述').fill('先问清楚，再写，最后检查');
  await form.getByLabel('需求').fill('做一个打招呼的 workflow：先问清楚，再写，最后检查');
  await page.screenshot({
    path: '.work/screenshots/w42-workflow-form.png',
    animations: 'disabled',
  });

  await form.getByTestId('codex-draft-submit').click();
  // 发起立即返回并跳到 Live；草稿在后台准备，完成后 Codex 启动
  await expect(page).toHaveURL(/\/live\?item=l-\d{8}-[a-z0-9]{6}$/, { timeout: 5_000 });
  const liveId = new URL(page.url()).searchParams.get('item') ?? '';
  const panel = page.getByTestId('live-panel');
  await expect(panel.getByTestId('live-engine')).toHaveText('Codex');
  await expect(panel.getByTestId('live-status')).toHaveAttribute('data-status', 'running', {
    timeout: 60_000,
  });
  await expect(panel.getByTestId('codex-draft-progress')).toHaveCount(0);
  await expect(panel.getByTestId('live-cwd')).toContainText('workflow-drafts/d-');
  await expect(panel.getByTestId('driver-switch')).toHaveCount(0);
  await expect.poll(() => terminalText(page)).toContain('Codex 替身');
  await expect.poll(() => terminalText(page)).toContain('做一个打招呼的 workflow');
  // 终端中的输入写进 Codex
  await page.getByTestId('live-terminal').click();
  await page.keyboard.type(`w42-${marker}`);
  await expect.poll(() => terminalText(page)).toContain(`w42-${marker}`);
  await expect(page.locator(`[data-live="${liveId}"]`).first()).toBeVisible();
  await page.screenshot({ path: '.work/screenshots/w42-live-codex.png', animations: 'disabled' });

  // workflow.yaml 多了一个还没有 skill 的小阶段时保存：以原文失败，草稿保留
  const { cwd } = (await (await page.request.get(`${api}/live/${liveId}`)).json()) as {
    cwd: string;
  };
  expect(fs.readdirSync(path.join(cwd, 'src/skills')).sort()).toEqual(
    [workflowId, 'stage-1'].sort(),
  );
  fs.appendFileSync(path.join(cwd, 'workflow.yaml'), '  - id: review\n');
  const save = panel.getByTestId('codex-draft-save');
  await expect(save).toHaveText('保存为 workflow');
  await save.click();
  const error = panel.getByTestId('codex-draft-error');
  await expect(error).toContainText('保存失败，草稿保留');
  await expect(error).toContainText(`缺少 workflow ${workflowId} 要求的 skill：review`);
  await expect(panel.getByTestId('codex-draft-saved')).toHaveCount(0);
  await page.screenshot({ path: '.work/screenshots/w42-save-error.png', animations: 'disabled' });

  // 结束进程后 resume 接着同一个会话
  await panel.getByRole('button', { name: '结束进程' }).click();
  await expect(panel.getByTestId('live-status')).toHaveAttribute('data-status', 'exited');
  await panel.getByTestId('codex-resume').click();
  await expect(panel.getByTestId('live-status')).toHaveAttribute('data-status', 'running');
  await expect(
    page.locator(`[data-live="${liveId}"] [data-testid="live-resume-count"]`),
  ).toHaveText('resume 1 次');
  await stopLive(page, liveId);
});

test('用 Codex 生成 variant：Workflow 页面的表单默认第一个 variant，保存按钮为"保存为 variant"', async ({
  page,
}) => {
  await page.goto('/workflows/lfg');
  await page.getByTestId('codex-variant-toggle').click();
  const form = page.getByTestId('codex-draft-variant');
  await expect(form.getByRole('heading')).toHaveText('用 Codex 生成 /lfg 的 variant');
  await expect(form.getByLabel('id（入口命令 /id）')).toHaveCount(0);
  // 选项只有 lfg 的 variant
  const options = await form.getByTestId('codex-draft-base').locator('option').allTextContents();
  expect(options.length).toBeGreaterThan(0);
  for (const text of options) expect(text).toMatch(/\(lfg\)$/);
  await form.getByTestId('codex-draft-base').selectOption(base.id);
  await form.getByLabel('需求').fill('让 interview 一次只问一个问题');
  await page.screenshot({ path: '.work/screenshots/w42-variant-form.png', animations: 'disabled' });
  await form.getByTestId('codex-draft-submit').click();
  await expect(page).toHaveURL(/\/live\?item=/, { timeout: 5_000 });
  const liveId = new URL(page.url()).searchParams.get('item') ?? '';
  const panel = page.getByTestId('live-panel');
  await expect(panel.getByTestId('codex-draft-save')).toHaveText('保存为 variant');
  await expect
    .poll(() => terminalText(page), { timeout: 60_000 })
    .toContain('让 interview 一次只问一个问题');
  await stopLive(page, liveId);
});

test('准备失败：显示失败那一步的原文与"重试准备"，重试从那一步接着做，完成后启动 Codex', async ({
  page,
  request,
}) => {
  // 第三个 skill 的本地来源暂时移走（e2e/services.ts 的 WFD_CODEX_SKILL_SOURCES）
  const source = path.join(root, '.work/e2e/codex-skills/writing-for-agents');
  const away = `${source}.away`;
  fs.rmSync(away, { recursive: true, force: true });
  fs.renameSync(source, away);
  const created = await request.post(`${api}/workflow-drafts`, {
    data: {
      mode: 'variant',
      workflowId: 'lfg',
      requirement: '准备失败的测试',
      baseVariantId: base.id,
    },
  });
  expect(created.status()).toBe(201);
  const { draft } = (await created.json()) as { draft: Draft };
  await page.goto(`/live?item=${draft.liveId}`);
  const progress = page.getByTestId('codex-draft-progress');
  await expect(progress).toHaveAttribute('data-status', 'failed', { timeout: 60_000 });
  await expect(progress).toContainText('准备失败，草稿保留');
  const failed = progress.locator('[data-step="skill:writing-for-agents"]');
  await expect(failed).toHaveAttribute('data-status', 'failed');
  await expect(failed).toContainText(`git ls-remote ${source} HEAD`);
  for (const step of ['copy-src', 'write-docs', 'skill:find-skills', 'skill:skill-creator']) {
    await expect(progress.locator(`[data-step="${step}"]`)).toHaveAttribute('data-status', 'done');
  }
  await expect(progress.locator('[data-step="start-codex"]')).toHaveAttribute(
    'data-status',
    'pending',
  );
  const panel = page.getByTestId('live-panel');
  await expect(panel.getByTestId('codex-draft-save')).toBeDisabled();
  await expect(panel.getByTestId('live-status')).toHaveAttribute('data-status', 'idle');
  await page.screenshot({
    path: '.work/screenshots/w42b-prepare-failed.png',
    animations: 'disabled',
  });

  fs.renameSync(away, source);
  await page.getByTestId('codex-draft-retry').click();
  await expect(panel.getByTestId('live-status')).toHaveAttribute('data-status', 'running', {
    timeout: 60_000,
  });
  await expect(progress).toHaveCount(0);
  await expect(panel.getByTestId('codex-draft-save')).toBeEnabled();
  await expect.poll(() => terminalText(page)).toContain('准备失败的测试');
  await page.screenshot({
    path: '.work/screenshots/w42b-prepare-retried.png',
    animations: 'disabled',
  });
  await stopLive(page, draft.liveId);
});

// 例子 workflow 的四个 skill 写进草稿（入口 skill 改名为 workflowId），workflow.yaml 为它的定义
function writeExample(dir: string, workflowId: string) {
  for (const name of fs.readdirSync(path.join(example, 'skills'))) {
    const target = name === 'hello-flow' ? workflowId : name;
    fs.mkdirSync(path.join(dir, 'src/skills', target), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'src/skills', target, 'SKILL.md'),
      fs
        .readFileSync(path.join(example, 'skills', name, 'SKILL.md'), 'utf8')
        .replace('name: hello-flow', `name: ${workflowId}`),
    );
  }
  fs.writeFileSync(
    path.join(dir, 'workflow.yaml'),
    stringify({
      id: workflowId,
      name: `你好 ${marker}`,
      stages: [{ id: 'gather' }, { id: 'draft' }, { id: 'review', repeatable: true }],
    }),
  );
}

test('保存为 workflow（自有管理器构建）：显示保存出的 workflow 与 variant 的链接，可以再次保存', async ({
  page,
  request,
}) => {
  const workflowId = `saved-${marker}`;
  const created = await request.post(`${api}/workflow-drafts`, {
    data: {
      mode: 'workflow',
      workflowId,
      name: `你好 ${marker}`,
      description: '打招呼',
      requirement: '做一个打招呼的 workflow',
    },
  });
  expect(created.status()).toBe(201);
  const { draft } = (await created.json()) as { draft: Draft };
  // 等后台准备完成（之后写的 skill 不会被准备的步骤覆盖）
  await expect
    .poll(
      async () =>
        ((await (await request.get(`${api}/workflow-drafts/${draft.id}`)).json()) as Draft).status,
      { timeout: 60_000 },
    )
    .toBe('open');
  // 测试代码直接写出 skill 文件（Contracts 17.5）
  writeExample(draft.dir, workflowId);
  await page.goto(`/live?item=${draft.liveId}`);
  const panel = page.getByTestId('live-panel');
  await panel.getByTestId('codex-draft-save').click();
  const saved = panel.getByTestId('codex-draft-saved');
  await expect(saved).toBeVisible({ timeout: 600_000 });
  await expect(saved.getByRole('link', { name: `workflow /${workflowId}` })).toBeVisible();
  await expect(saved.getByRole('link', { name: `基线 (${workflowId})` })).toBeVisible();
  await page.screenshot({ path: '.work/screenshots/w42-save-success.png', animations: 'disabled' });

  await panel.getByTestId('codex-draft-save').click();
  await expect(saved.getByRole('link', { name: `Codex ${draft.id} (${workflowId})` })).toBeVisible({
    timeout: 600_000,
  });
  await stopLive(page, draft.liveId);

  await saved.getByRole('link', { name: `基线 (${workflowId})` }).click();
  await expect(page).toHaveURL(/\/variants\/[0-9a-f-]{36}$/);
  await expect(page.getByTestId('breadcrumb')).toHaveText(`Workflows › 你好 ${marker} › 基线`);
  await expect(page.getByTestId('variant-draft')).toHaveText(`来自 Codex 草稿 ${draft.id}`);
  await expect(page.getByTestId('build-status')).toHaveText('已构建');
});
