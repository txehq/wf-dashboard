import { randomUUID } from 'node:crypto';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { runsServerPort } from '../ports.js';

// 数据目录由 server/scripts/prepare-runs-e2e.ts 准备：导入 W4 端到端的三个已结束 run。
// 实时一项是真实运行：构建基线 variant，发起 lfg-calculator 的 1 个 run（在 txehq 建仓库、写 vault），
// 在 interview 阶段接管并回答一次，交还模拟用户，再取消
const api = `http://127.0.0.1:${String(runsServerPort)}/api`;
const marker = randomUUID().slice(0, 8);

const shot = (target: Page | Locator, name: string) =>
  target.screenshot({
    path: `.work/screenshots/w10-${name}.png`,
    animations: 'disabled',
    ...('goto' in target ? { fullPage: true } : {}),
  });

test('已评分的 lfg run：阶段、对话、产物与 rubric 得分', async ({ page }) => {
  await page.goto('/runs/r-20261009-dqva52');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('课堂用的网页计算器');
  await expect(page.getByTestId('run-status').first()).toHaveAttribute('data-status', 'succeeded');
  const stages = page.getByTestId('run-stages');
  for (const stage of ['interview', 'research', 'plan', 'ticketing']) {
    await expect(stages.getByTestId(`stage-${stage}`)).toHaveAttribute('data-status', 'done');
  }
  await expect(stages.getByTestId('stage-live')).toHaveCount(0);
  await expect(page.getByTestId('run-costs')).toContainText('$78.90');
  await expect(
    page.getByTestId('run-links').getByRole('link', { name: /GitHub 仓库/ }),
  ).toHaveAttribute('href', 'https://github.com/txehq/wfe-r-20261009-dqva52');

  const conversation = page.getByTestId('conversation');
  await expect(conversation.getByTestId('message-initial')).toContainText('/lfg 做一个计算器');
  await expect(conversation.getByTestId('message-agent')).toHaveCount(8);
  // dispatch gate 的回答，以及最后一次回答判断运行可以结束
  await expect(
    conversation.getByTestId('message-simulated_user').filter({ hasText: '不派发，到此结束' }),
  ).toHaveCount(1);
  await expect(conversation.getByTestId('message-simulated_user').last()).toContainText(
    '判断运行可以结束',
  );
  await expect(page.getByTestId('takeover-closed')).toHaveText('run 已不在运行，不能再回答。');

  const artifacts = page.getByTestId('run-artifacts');
  await artifacts.getByRole('tab', { name: /Brief/ }).click();
  await expect(artifacts.getByTestId('artifact-markdown').locator('h1').first()).toBeVisible();

  const grades = page.getByTestId('run-grades');
  await expect(grades).toContainText('合计 73 / 84');
  await expect(grades.getByTestId('grade-brief')).toContainText('26 / 28');
  await expect(grades.getByTestId('grade-tickets')).toContainText('15 / 18');
  await expect(page.getByTestId('timeline')).toBeVisible();
  await shot(page, 'graded');
});

test('已评分的 ic run 与失败的 run', async ({ page }) => {
  await page.goto('/runs/r-20261009-a26chw');
  const grades = page.getByTestId('run-grades');
  await expect(grades).toContainText('19 / 19');
  await expect(grades).toContainText('未到达');
  await expect(grades.getByTestId('grade-tests').locator('tbody tr')).toHaveCount(19);
  const stages = page.getByTestId('run-stages');
  await expect(stages.getByTestId('stage-acceptance')).toHaveAttribute('data-status', 'skipped');
  await expect(stages.getByTestId('stage-fix-pr')).toHaveAttribute('data-status', 'active');
  await expect(
    page.getByTestId('run-links').getByRole('link', { name: /Linear 工单/ }),
  ).toBeVisible();
  await expect(page.getByTestId('run-artifacts').getByRole('link', { name: /PR/ })).toContainText(
    '草稿',
  );
  await shot(page, 'graded-ic');

  await page.goto('/runs/r-20261009-780j7l');
  const error = page.getByTestId('run-error');
  await expect(error).toContainText('发生在 /ic · claim');
  await expect(error).toContainText('Post "https://api.github.com/graphql": EOF');
  await expect(page.getByTestId('run-grades')).toHaveCount(0);
});

test('列表筛选', async ({ page }) => {
  await page.goto('/runs');
  await page.getByLabel('状态').selectOption({ label: '失败' });
  await expect(page.getByTestId('run-row')).toHaveCount(1);
  await expect(page.getByTestId('run-row')).toHaveAttribute('data-run', 'r-20261009-780j7l');
  await page.getByLabel('状态').selectOption({ label: '全部' });
  await page.getByLabel('task', { exact: true }).selectOption({ label: '课堂用的网页计算器' });
  await expect(page.locator('[data-run="r-20261009-dqva52"]')).toBeVisible();
  await expect(page.locator('[data-run="r-20261009-a26chw"]')).toHaveCount(0);
});

test.describe('真实运行', () => {
  test.setTimeout(40 * 60_000);

  test('发起 batch、实时更新、接管与交还、取消', async ({ page, request }) => {
    page.on('dialog', (dialog) => {
      void dialog.accept();
    });
    const variantName = `W10 e2e ${marker}`;
    const created = await request.post(`${api}/variants`, {
      data: { name: variantName, model: 'opus', effort: 'high' },
    });
    expect(created.status()).toBe(201);
    const variant = (await created.json()) as { id: string };
    const built = await request.post(`${api}/variants/${variant.id}/build`, { timeout: 900_000 });
    expect(((await built.json()) as { buildStatus: string }).buildStatus).toBe('built');

    // 发起
    await page.goto('/runs');
    const launch = page.getByTestId('launch-batch');
    await expect(launch.getByRole('checkbox', { name: /导入/ }).first()).toBeDisabled();
    await expect(launch.getByRole('link', { name: '去构建' }).first()).toBeVisible();
    await launch.getByRole('checkbox', { name: variantName }).check();
    await launch.getByRole('checkbox', { name: '课堂用的网页计算器' }).check();
    await launch.getByRole('spinbutton').fill('1');
    await expect(page.getByTestId('launch-summary')).toContainText(
      '1 个 variant × 1 个 task × 1 次 = 1 个 run',
    );
    await expect(page.getByTestId('launch-summary')).toContainText('在 txehq 建一个空仓库');
    await shot(launch, 'launch');
    await launch.getByRole('button', { name: '发起 1 个 run' }).click();
    await expect(page.getByTestId('launch-done')).toBeVisible();
    const batchId =
      (await page.getByTestId('launch-done').locator('.font-mono').textContent()) ?? '';

    // 列表经 run.* 事件更新，不刷新页面
    const group = page.locator(`[data-batch="${batchId}"]`);
    const row = group.getByTestId('run-row');
    await expect(row).toHaveCount(1);
    await expect(row.getByTestId('run-status')).toHaveAttribute('data-status', 'running', {
      timeout: 300_000,
    });
    const runId = (await row.getAttribute('data-run')) ?? '';
    await shot(page, 'list');

    // 详情：运行中
    await row.getByRole('link').first().click();
    await expect(page).toHaveURL(new RegExp(`/runs/${runId}$`));
    await expect(page.getByTestId('run-mode')).toHaveText('模拟用户回答中');
    await expect(page.getByTestId('message-initial')).toContainText('/lfg 做一个计算器');
    await expect(
      page.getByTestId('run-links').getByRole('link', { name: /GitHub 仓库/ }),
    ).toBeVisible();

    // 在第一个提问之前接管，interview 的提问由页面回答
    await page.getByRole('button', { name: '接管' }).click();
    await expect(page.getByTestId('run-mode')).toHaveText('人工回答中');
    await expect(page.getByTestId('intervened').first()).toBeVisible();
    await expect(page.getByTestId('message-system').last()).toContainText('页面接管了对话');
    await expect(page.getByTestId('takeover-hint')).toHaveText(
      'agent 正在工作，有新的提问时在这里回答。',
    );
    const stages = page.getByTestId('run-stages');
    await expect(stages.getByTestId('stage-interview')).toHaveAttribute('data-status', 'active', {
      timeout: 600_000,
    });
    await expect(stages.getByTestId('stage-live')).toBeVisible();

    const reply = page.getByLabel('你的回答');
    const choice = page.getByTestId('question-reply');
    await expect(reply.or(choice)).toBeVisible({ timeout: 900_000 });
    await expect(page.getByTestId('message-agent').last()).toBeVisible();
    if (await reply.isVisible()) {
      await reply.fill(
        '使用者是初一到初三的学生，在学校机房（Windows 7、Chrome 109）和家里用，我会在投影上演示。机房经常断网，必须完全离线。其他问题请继续问。',
      );
      await shot(page, 'takeover');
      await page.getByRole('button', { name: '发送回答' }).click();
    } else {
      for (const fieldset of await choice.locator('fieldset').all()) {
        await fieldset.locator('input[type=radio], input[type=checkbox]').first().check();
      }
      await shot(page, 'takeover');
      await choice.getByRole('button', { name: '提交选择' }).click();
    }
    await expect(page.getByTestId('message-human')).toHaveCount(1);
    await expect(page.getByTestId('message-human')).toContainText('人工回答');

    await page.getByRole('button', { name: '交还模拟用户' }).click();
    await expect(page.getByTestId('run-mode')).toHaveText('模拟用户回答中');
    await expect(page.getByTestId('message-system').last()).toContainText('对话交还给模拟用户');
    // 交还后模拟用户接着回答下一个提问
    await expect(page.getByTestId('message-simulated_user').first()).toBeVisible({
      timeout: 900_000,
    });

    // 请求流：session 写出后实时追加，停在最新一条；向上滚动后不再跟随
    const timeline = page.getByTestId('timeline');
    await expect(timeline).toBeVisible({ timeout: 900_000 });
    await expect(timeline).toHaveAttribute('data-following', 'true');
    // e2e 的 tsconfig 没有 DOM 类型，滚动容器按需要的字段描述
    interface Scroller {
      scrollHeight: number;
      clientHeight: number;
      scrollTop: number;
    }
    // 请求多到可以滚动后，最后一条在视野内
    await expect
      .poll(() => timeline.evaluate((el: Scroller) => el.scrollHeight - el.clientHeight), {
        timeout: 900_000,
      })
      .toBeGreaterThan(200);
    await expect
      .poll(() =>
        timeline.evaluate((el: Scroller) => el.scrollHeight - el.scrollTop - el.clientHeight),
      )
      .toBeLessThan(48);
    await timeline.evaluate((el: Scroller) => {
      el.scrollTop = 0;
    });
    await expect(timeline).toHaveAttribute('data-following', 'false');
    await expect(page.getByRole('button', { name: '跳到最新' })).toBeVisible();
    await page.getByRole('button', { name: '跳到最新' }).click();
    await expect(timeline).toHaveAttribute('data-following', 'true');
    // 运行中的详情：模拟用户模式，阶段、对话、请求流都在更新
    await shot(page, 'running');

    // 取消
    await page.getByRole('button', { name: '取消运行' }).click();
    await expect(page.getByTestId('run-status').first()).toHaveAttribute(
      'data-status',
      'cancelled',
      { timeout: 120_000 },
    );
    await expect(page.getByTestId('message-system').last()).toContainText('页面取消了运行');
    await expect(page.getByTestId('takeover-closed')).toBeVisible();
    await expect(page.getByRole('button', { name: '取消运行' })).toHaveCount(0);
  });
});
