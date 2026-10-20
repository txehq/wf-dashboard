import { expect, type Page, test } from './test.js';

// 服务端由 pnpm start 的方式启动（构建后一个端口提供页面与 API）。开始前在设置中把 judge 换成 gateway 上
// 没有渠道的 claude-haiku-4-5-20251001-cc：环境清单中这一项真实未通过，其余各项按本机的真实状态
test.describe.configure({ mode: 'serial' });
// 第一次检查真实执行全部 11 项，Codex 与 Linear 偶尔要一两分钟
test.setTimeout(600_000);

const pages = ['Sessions', 'Runs', 'Variants', 'Tasks', 'Compare'];
const BROKEN_MODEL = 'claude-haiku-4-5-20251001-cc';

// 修复时换上的 judge 模型：服务端的默认值 claude-sonnet-5-5（Contracts 4）
const JUDGE_MODEL = 'claude-sonnet-5-5';

test.beforeAll(async ({ request }) => {
  const settings = (await (await request.get('/api/settings')).json()) as {
    models: Record<string, string>;
  };
  const saved = await request.put('/api/settings', {
    data: { ...settings, models: { ...settings.models, judge: BROKEN_MODEL } },
  });
  expect(saved.status()).toBe(200);
});

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `.work/screenshots/w14-${name}.png`, animations: 'disabled' });

test('一个端口提供全部页面与 API', async ({ page, baseURL }) => {
  await page.goto('/');
  await expect(page).toHaveURL(`${String(baseURL)}/sessions`);
  const nav = page.getByRole('navigation', { name: '主导航' });
  for (const name of pages) {
    await nav.getByRole('link', { name }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(name);
  }
  // 浏览器直接打开页面内的路径，服务端返回 index.html，由前端路由处理
  await page.goto('/tasks/lfg-calculator');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('计算器');
  await expect(page.getByTestId('server-status')).toHaveText('服务端：ok');
});

test('导航底部的环境状态与检查清单：展开与修复方法', async ({ page }) => {
  await page.goto('/sessions');
  const status = page.getByTestId('environment-status');
  // 第一次检查真实执行全部 11 项（含 codex exec 与 Linear MCP）
  await expect(status).toHaveText(/环境：有 \d+ 项未通过/, { timeout: 180_000 });
  await shot(page, 'nav-status');

  await status.click();
  const dialog = page.getByTestId('environment-dialog');
  await expect(dialog.getByRole('heading', { name: '运行环境' })).toBeVisible();
  await expect(dialog.getByTestId('environment-checks').getByRole('listitem')).toHaveCount(11);
  await expect(dialog.getByTestId('env-check-model-stage-check')).toHaveCount(0);

  // 未通过的项排在最前并默认展开：真实的 503 输出与修复方法
  const stage = dialog.getByTestId('env-check-model-judge');
  await expect(dialog.getByRole('listitem').first()).toHaveAttribute(
    'data-testid',
    'env-check-model-judge',
  );
  await expect(stage.getByRole('button')).toHaveAttribute('aria-expanded', 'true');
  await expect(stage).toContainText(BROKEN_MODEL);
  await expect(stage.getByTestId('env-detail')).toContainText('No available channel');
  await expect(stage.getByTestId('env-fix')).toContainText('为「评分（judge）」换一个模型');
  await shot(page, 'checklist');

  // 通过的项默认收起，点开看到检查到的版本，不显示修复方法
  const claude = dialog.getByTestId('env-check-claude');
  await expect(claude.getByRole('button')).toHaveAttribute('aria-expanded', 'false');
  await expect(claude.getByTestId('env-detail')).toHaveCount(0);
  await claude.getByRole('button').click();
  await expect(claude.getByTestId('env-detail')).toContainText('(Claude Code)');
  await expect(claude.getByTestId('env-fix')).toHaveCount(0);

  // 未通过的项点击后收起
  await stage.getByRole('button').click();
  await expect(stage.getByTestId('env-fix')).toHaveCount(0);
  await stage.getByRole('button').click();
  await expect(stage.getByTestId('env-fix')).toBeVisible();
  await shot(page, 'checklist-expanded');

  // 重新检查绕过缓存，检查时间更新
  const description = dialog.locator('p').first();
  const before = await description.textContent();
  await dialog.getByRole('button', { name: '重新检查' }).click();
  await expect(dialog.getByRole('button', { name: '检查中…' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: '重新检查' })).toBeEnabled({ timeout: 180_000 });
  await expect(description).not.toHaveText(before ?? '');

  await dialog.getByRole('button', { name: '关闭' }).click();
  await expect(dialog).toHaveCount(0);
});

test('发起 batch 处列出未通过的项，改好设置后提示消失', async ({ page }) => {
  await page.goto('/runs');
  const warning = page.getByTestId('environment-warning');
  await expect(warning).toContainText(`gateway：评分（judge）模型 ${BROKEN_MODEL}`, {
    timeout: 180_000,
  });
  await page.getByTestId('launch-batch').screenshot({
    path: '.work/screenshots/w14-launch-warning.png',
    animations: 'disabled',
  });
  await warning.getByRole('button', { name: '查看原因与修复方法' }).click();
  const dialog = page.getByTestId('environment-dialog');
  await expect(dialog.getByTestId('env-check-model-judge').getByTestId('env-fix')).toBeVisible();
  await dialog.getByRole('button', { name: '关闭' }).click();

  // 按 fix 的做法在设置中为 judge 换一个模型（默认的 claude-sonnet-5-5）：角色模型变了，服务端重新检查
  await page.getByTestId('run-settings').locator('summary').click();
  await page.getByLabel('评分（judge）的模型').fill(JUDGE_MODEL);
  await page.getByRole('button', { name: '保存设置' }).click();
  const status = page.getByTestId('environment-status');
  await expect(status).toHaveText('环境检查中…');
  await expect(status).not.toHaveText('环境检查中…', { timeout: 180_000 });
  // 本机其余 10 项都通过
  await expect(status).toHaveText('环境：全部通过');
  await expect(warning).toHaveCount(0);
  await status.click();
  await expect(
    page.getByTestId('env-check-model-judge').locator('[aria-label="通过"]'),
  ).toBeVisible();
  await expect(page.getByTestId('env-check-model-judge')).toContainText(JUDGE_MODEL);
});

// Contracts 第 13 节：副本仓库可用的自托管 runner 标签，默认 arc-linux-dind，设置中每行一个
test('设置中编辑 copyRunnerLabels：保存后读回，刷新后仍在', async ({ page, request }) => {
  await page.goto('/runs');
  await page.getByTestId('run-settings').locator('summary').click();
  const labels = page.getByLabel('副本仓库可用的自托管 runner 标签');
  await expect(labels).toHaveValue('arc-linux-dind');
  await labels.fill('arc-linux-dind\n\n  linux-large  ');
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByRole('button', { name: '保存设置' })).toBeDisabled();
  const saved = (await (await request.get('/api/settings')).json()) as {
    copyRunnerLabels: string[];
  };
  expect(saved.copyRunnerLabels).toEqual(['arc-linux-dind', 'linux-large']);
  await page.screenshot({ path: '.work/screenshots/w29-settings.png', animations: 'disabled' });

  await page.reload();
  await page.getByTestId('run-settings').locator('summary').click();
  await expect(page.getByLabel('副本仓库可用的自托管 runner 标签')).toHaveValue(
    'arc-linux-dind\nlinux-large',
  );
  // 改回默认值
  await page.getByLabel('副本仓库可用的自托管 runner 标签').fill('arc-linux-dind');
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByRole('button', { name: '保存设置' })).toBeDisabled();
});
