import path from 'node:path';
import { expect, test } from '@playwright/test';

// 真实数据：两个 dashboard 发起的 run 的 session 原文（server/scripts/prepare-sessions-e2e.ts 放进
// .work/e2e/projects，服务端以 WFD_CLAUDE_PROJECTS 指向它）：ic run 40f6915a（/ic TXE-3764，
// claim、readiness、implement、open-pr 都由 Skill 调用开始，停在 open-pr）与 lfg run dqva52 的 session
// （四个阶段都写出了产物，含子代理）。三轮 PR 的 f0aca373 的判定由 gateway 项目的 report.test 覆盖
const projects = path.resolve(import.meta.dirname, '../.work/e2e/projects');
const icSource = path.join(projects, '-e2e-ic-run');
const lfgSource = path.join(projects, '-e2e-lfg-run');
const icSession = '40f6915a-cd31-4312-866c-dcb377515c42';
const lfgSession = '0188c133-3e7b-4592-a963-fc717cf283de';
const shots = '.work/screenshots';

test('Sessions：来源勾选、列表、详情、阶段判定、Skill 调用的边界、阶段请求、tool 调用与子代理', async ({
  page,
  request,
}) => {
  // ic run 的判定约 3 次模型调用；lfg 按产物判定，不调用模型
  test.setTimeout(300_000);

  await page.goto('/sessions');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sessions');

  // 来源勾选：新数据库没有勾选任何目录，列表为空状态，来源列表默认展开
  await expect(page.getByText('在上方勾选来源目录后，这里会列出其中的 session。')).toBeVisible();
  for (const source of [icSource, lfgSource]) {
    const checkbox = page.getByRole('checkbox', { name: source, exact: true });
    await expect(checkbox).not.toBeChecked();
    await checkbox.check();
    await expect(checkbox).toBeChecked();
  }
  await expect(page.getByTestId('import-result')).toContainText('已导入');

  // 列表：请求数与花费以导入后 API 的值为准
  const icRow = page.getByTestId('session-row').filter({ hasText: icSession.slice(0, 8) });
  const lfgRow = page.getByTestId('session-row').filter({ hasText: lfgSession.slice(0, 8) });
  const detailJson = (await (await request.get(`/api/sessions/${icSession}`)).json()) as {
    requestCount: number;
    costUsd: number;
  };
  await expect(icRow).toContainText('/ic TXE-3764');
  await expect(icRow).toContainText(String(detailJson.requestCount));
  await expect(icRow).toContainText('未分析');
  await expect(lfgRow).toContainText('/lfg 做一个计算器');
  await page.getByRole('button', { name: /来源目录/ }).click();
  await page.screenshot({ path: `${shots}/w8-list.png`, fullPage: true, animations: 'disabled' });

  // 搜索与 workflow 筛选
  await page.getByRole('radio', { name: '/ic' }).click();
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  await expect(icRow).toBeVisible();
  await page.getByRole('searchbox', { name: '搜索 session' }).fill('40f6915a');
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  await page.getByRole('searchbox', { name: '搜索 session' }).fill('不存在的标题');
  await expect(page.getByText('没有符合条件的 session。')).toBeVisible();
  await page.getByRole('button', { name: '清除筛选' }).click();
  await expect(page.getByTestId('session-row')).toHaveCount(2);

  // ic session 的详情顶部
  await icRow.getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${icSession}$`));
  const summary = page.getByTestId('session-summary');
  await expect(summary.getByRole('heading', { level: 1 })).toHaveText('/ic TXE-3764');
  await expect(summary).toContainText(String(detailJson.requestCount));
  await expect(summary.getByRole('figure', { name: '各 tool 的调用次数' })).toContainText('Bash');
  await expect(page.getByTestId('outside-stats')).toHaveCount(0);

  // 分析：后台逐批判定，页面显示进度；完成后自动显示结果
  await page.getByRole('button', { name: '分析阶段' }).click();
  const progress = page.getByTestId('analyze-progress');
  await expect(progress).toBeVisible();
  await page.screenshot({ path: `${shots}/w8-analyzing.png`, animations: 'disabled' });
  const checksCost = page.getByTestId('checks-cost');
  await expect(checksCost).toBeVisible({ timeout: 240_000 });
  await expect(checksCost).toContainText('次模型调用');
  await expect(page.getByTestId('outside-stats')).toContainText('流程外');

  // 一轮 ic：claim、readiness、implement、open-pr 都由 Skill 调用开始；没有运行 /acceptance，
  // Skill open-pr 越过了它；run 停在 open-pr
  const ic = page.getByTestId('workflow-ic');
  await expect(page.getByTestId('workflow-lfg')).toHaveCount(0);
  await expect(ic.getByTestId('cycles-ic').getByRole('tab')).toHaveCount(1);
  for (const stage of ['claim', 'readiness', 'implement'])
    await expect(ic.getByTestId(`stage-${stage}`)).toHaveAttribute('data-status', 'done');
  await expect(ic.getByTestId('stage-acceptance')).toHaveAttribute('data-status', 'skipped');
  await expect(ic.getByTestId('stage-acceptance')).toContainText('跳过');
  await expect(ic.getByTestId('stage-open-pr')).toHaveAttribute('data-status', 'active');
  for (const stage of ['fix-pr', 'ready-for-review'])
    await expect(ic.getByTestId(`stage-${stage}`)).toHaveAttribute('data-status', 'not-reached');
  await expect(ic.getByText('各阶段花费')).toBeVisible();
  await ic.screenshot({ path: `${shots}/w8-ic-graph.png`, animations: 'disabled' });

  // implement：判定方式为 Skill 调用，证据是那次调用，只列出该阶段的请求
  const stages = (await (await request.get(`/api/sessions/${icSession}/stages`)).json()) as {
    ic: { stages: { stage: string; startSeq: number; endSeq: number }[] }[];
  };
  const implement = stages.ic[0]?.stages.find((s) => s.stage === 'implement');
  if (implement === undefined) throw new Error('没有 implement 阶段');
  await ic.getByTestId('stage-implement').click();
  await expect(page).toHaveURL(/stage=ic%3Aimplement/);
  const detail = page.getByTestId('stage-detail');
  await expect(detail.getByRole('heading', { level: 2 })).toHaveText('/ic · implement');
  await expect(detail.getByTestId('stage-cycle')).toHaveText('第 1 轮');
  await expect(detail.getByTestId('stage-method')).toHaveText('Skill 调用');
  await expect(detail.getByTestId('stage-evidence')).toContainText('Skill 调用');
  await expect(detail.getByTestId('stage-evidence')).toContainText('Skill: implement TXE-3764');
  await expect(detail).toContainText(
    `#${String(implement.startSeq)} – #${String(implement.endSeq)}`,
  );
  const firstRequest = detail.getByTestId('request-row').first();
  await expect(firstRequest).toContainText(`#${String(implement.startSeq)}`);
  const toolCall = firstRequest.getByTestId('tool-call').first();
  await toolCall.getByRole('button').first().click();
  const toolDetail = toolCall.getByTestId('tool-call-detail');
  await expect(toolDetail).toContainText('参数');
  await expect(toolDetail).toContainText('"skill": "implement"');
  await expect(toolDetail).toContainText('结果');
  await detail.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/w8-requests.png`, animations: 'disabled' });

  // acceptance：被 Skill open-pr 越过，证据是那次 Skill 调用
  await ic.getByTestId('stage-acceptance').click();
  await expect(detail.getByRole('heading', { level: 2 })).toHaveText('/ic · acceptance');
  await expect(detail.getByTestId('stage-method')).toHaveText('Skill 调用');
  await expect(detail.getByTestId('stage-evidence')).toContainText('越过它的 Skill 调用');
  await expect(detail.getByTestId('stage-evidence')).toContainText('Skill: open-pr TXE-3764');
  await expect(detail).toContainText('这个阶段被跳过，没有请求。');
  await detail.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/w22-acceptance-skill.png`, animations: 'disabled' });

  // 1280px 宽：阶段框全部显示，页面与阶段图都没有横向滚动；ic 换成两行
  await page.setViewportSize({ width: 1280, height: 1000 });
  const noHorizontalScroll = async (selector: string) =>
    page.locator(selector).evaluate((el) => el.scrollWidth <= el.clientWidth);
  await expect.poll(() => noHorizontalScroll('html')).toBe(true);
  const icGraph = page.getByTestId('stage-graph-ic');
  await expect.poll(() => icGraph.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  await expect(icGraph).toHaveAttribute('data-rows', '2');
  await ic.scrollIntoViewIfNeeded();
  await ic.screenshot({ path: `${shots}/w16-graph-1280.png`, animations: 'disabled' });

  // 已分析的状态回到列表
  await page.getByRole('link', { name: '全部 session' }).click();
  await expect(icRow).toContainText('已分析');

  // lfg session：按产物文件判定，四个阶段完成并停在 dispatch gate 之后
  await page.setViewportSize({ width: 1600, height: 1000 });
  await lfgRow.getByRole('link').click();
  await page.getByRole('button', { name: '分析阶段' }).click();
  const lfg = page.getByTestId('workflow-lfg');
  await expect(lfg).toBeVisible({ timeout: 60_000 });
  for (const stage of ['interview', 'research', 'plan', 'ticketing'])
    await expect(lfg.getByTestId(`stage-${stage}`)).toHaveAttribute('data-status', 'done');
  await expect(lfg.getByTestId('stage-dispatch-gate')).toContainText('已停在这里');
  await expect(page.getByTestId('stage-graph-lfg')).toHaveAttribute('data-rows', '1');
  await lfg.screenshot({ path: `${shots}/w8-lfg-graph.png`, animations: 'disabled' });

  // research 阶段：判定方式为产物文件；Agent 调用展开后嵌套显示子代理的请求行
  await lfg.getByTestId('stage-research').click();
  await expect(detail.getByRole('heading', { level: 2 })).toHaveText('/lfg · research');
  await expect(detail.getByTestId('stage-method')).toHaveText('按产物文件判定');
  await detail.getByTestId('subagent-jump').first().click();
  const nested = detail.getByTestId('subagent-rows').first();
  await expect(nested).toBeVisible();
  await expect(nested.getByTestId('request-row').first()).toContainText('#0');
  await nested.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/w8-subagent.png`, animations: 'disabled' });
});
