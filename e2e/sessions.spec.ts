import path from 'node:path';
import { expect, test } from './test.js';

// 真实数据（server/scripts/prepare-sessions-e2e.ts 放进 .work/e2e/projects，服务端以 WFD_CLAUDE_PROJECTS
// 指向它）：两个 dashboard 发起的 run 的 session 原文——ic run 40f6915a（/ic TXE-3764，claim、readiness、
// implement、open-pr 都由 Skill 调用开始，停在 open-pr）与 lfg run dqva52（四个阶段都由 Skill 调用开始，
// 含子代理）——以及本机的 f0aca373（/interview 一轮 lfg，Skill open-pr 开启的三轮 ic）。
// 这个数据库中没有 run 行：三个 session 都按离线 session 划分，最后一个阶段为 active
const projects = path.resolve(import.meta.dirname, '../.work/e2e/projects');
const icSource = path.join(projects, '-e2e-ic-run');
const lfgSource = path.join(projects, '-e2e-lfg-run');
const prsSource = path.join(projects, '-e2e-txe-workflow');
const icSession = '40f6915a-cd31-4312-866c-dcb377515c42';
const lfgSession = '0188c133-3e7b-4592-a963-fc717cf283de';
const prsSession = 'f0aca373-863f-4d62-babd-f48055092328';
const shots = '.work/screenshots';

// 第二个用例再勾选 f0aca373 的来源：第一个用例的列表只有两个 session
test.describe.configure({ mode: 'serial' });
test('Sessions：来源勾选、列表、详情、导入即有的阶段、进入阶段的调用、阶段请求、tool 调用与子代理', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);

  await page.goto('/sessions');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sessions');

  // 来源勾选：新数据库没有勾选任何目录，列表为空状态，来源列表默认展开
  await expect(page.getByText('在上方勾选来源目录后，这里会列出其中的 session。')).toBeVisible();
  for (const source of [icSource, lfgSource]) {
    const checkbox = page.getByRole('checkbox', { name: source, exact: true });
    await expect(checkbox).not.toBeChecked();
    // 导入进行中时全部勾选框不可用；勾选状态在导入完成后才更新
    await expect(checkbox).toBeEnabled();
    await checkbox.click();
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

  // ic session 的详情：阶段在导入时已经划分，打开即可见，没有分析按钮
  await icRow.getByRole('link').click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${icSession}$`));
  const summary = page.getByTestId('session-summary');
  await expect(summary.getByRole('heading', { level: 1 })).toHaveText('/ic TXE-3764');
  await expect(summary).toContainText(String(detailJson.requestCount));
  await expect(summary.getByRole('figure', { name: '各 tool 的调用次数' })).toContainText('Bash');
  await expect(page.getByRole('button', { name: '分析阶段' })).toHaveCount(0);
  await expect(page.getByTestId('outside-stats')).toContainText('流程外');

  // 一轮 ic（/ic TXE-3764 开启）：claim、readiness、implement、open-pr 都由 Skill 调用开始；
  // 没有调用 acceptance，跳过；session 停在 open-pr
  const ic = page.getByTestId('workflow-ic');
  await expect(page.getByTestId('workflow-lfg')).toHaveCount(0);
  await expect(ic.getByTestId('cycles-ic').getByRole('tab')).toHaveCount(1);
  await expect(ic.getByTestId('cycles-ic').getByRole('tab')).toContainText('/ic TXE-3764');
  for (const stage of ['claim', 'readiness', 'implement']) {
    await expect(ic.getByTestId(`stage-${stage}`)).toHaveAttribute('data-status', 'done');
    await expect(ic.getByTestId(`stage-${stage}`).getByTestId('stage-entries')).toHaveText('1 次');
  }
  await expect(ic.getByTestId('stage-acceptance')).toHaveAttribute('data-status', 'skipped');
  await expect(ic.getByTestId('stage-acceptance')).toContainText('跳过');
  await expect(ic.getByTestId('stage-open-pr')).toHaveAttribute('data-status', 'active');
  for (const stage of ['fix-pr', 'ready-for-review'])
    await expect(ic.getByTestId(`stage-${stage}`)).toHaveAttribute('data-status', 'not-reached');
  await expect(ic.getByText('各阶段花费')).toBeVisible();
  await ic.screenshot({ path: `${shots}/w8-ic-graph.png`, animations: 'disabled' });

  // implement：证据是进入它的那次 Skill 调用，只列出该阶段的请求
  const stages = (await (await request.get(`/api/sessions/${icSession}/stages`)).json()) as {
    workflows: {
      workflow: string;
      cycles: { stages: { stage: string; startSeq: number; endSeq: number }[] }[];
    }[];
  };
  const implement = stages.workflows
    .find((b) => b.workflow === 'ic')
    ?.cycles[0]?.stages.find((s) => s.stage === 'implement');
  if (implement === undefined) throw new Error('没有 implement 阶段');
  await ic.getByTestId('stage-implement').click();
  await expect(page).toHaveURL(/stage=ic%3Aimplement/);
  const detail = page.getByTestId('stage-detail');
  await expect(detail.getByRole('heading', { level: 2 })).toHaveText('/ic · implement');
  await expect(detail.getByTestId('stage-cycle')).toHaveText('第 1 轮 · /ic TXE-3764');
  await expect(detail.getByTestId('stage-entries')).toHaveText('调用 1 次');
  await expect(detail.getByTestId('stage-evidence')).toContainText('Skill 调用');
  await expect(detail.getByTestId('stage-evidence')).toContainText('Skill: implement TXE-3764');
  await expect(detail.getByTestId('stage-evidence')).toContainText(
    `#${String(implement.startSeq)}`,
  );
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

  // acceptance：没有被调用，没有证据与请求
  await ic.getByTestId('stage-acceptance').click();
  await expect(detail.getByRole('heading', { level: 2 })).toHaveText('/ic · acceptance');
  await expect(detail).toContainText('这一轮中这个阶段没有被调用，直接进入了后面的阶段。');
  await expect(detail).toContainText('这个阶段被跳过，没有请求。');
  await expect(detail.getByTestId('stage-entries')).toHaveCount(0);

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

  // lfg session：/lfg 开启的一轮，四个阶段都由 Skill 调用开始，session 停在 ticketing
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.getByRole('link', { name: '全部 session' }).click();
  await lfgRow.getByRole('link').click();
  const lfg = page.getByTestId('workflow-lfg');
  await expect(lfg.getByTestId('cycles-lfg').getByRole('tab')).toContainText('/lfg 做一个计算器');
  for (const stage of ['interview', 'research', 'plan'])
    await expect(lfg.getByTestId(`stage-${stage}`)).toHaveAttribute('data-status', 'done');
  await expect(lfg.getByTestId('stage-ticketing')).toHaveAttribute('data-status', 'active');
  await expect(lfg.getByTestId('stage-dispatch-gate')).toHaveCount(0);
  await expect(page.getByTestId('stage-graph-lfg')).toHaveAttribute('data-rows', '1');
  await lfg.screenshot({ path: `${shots}/w8-lfg-graph.png`, animations: 'disabled' });

  // research 阶段：证据是 Skill research；Agent 调用展开后嵌套显示子代理的请求行
  await lfg.getByTestId('stage-research').click();
  await expect(detail.getByRole('heading', { level: 2 })).toHaveText('/lfg · research');
  await expect(detail.getByTestId('stage-evidence')).toContainText('Skill: research');
  await detail.getByTestId('subagent-jump').first().click();
  const nested = detail.getByTestId('subagent-rows').first();
  await expect(nested).toBeVisible();
  await expect(nested.getByTestId('request-row').first()).toContainText('#0');
  await nested.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/w8-subagent.png`, animations: 'disabled' });
});

test('f0aca373：导入后立即看到 /interview 一轮 lfg 与三轮 ic，fix-pr 显示修复轮数', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  await page.goto('/sessions');
  const sourcesToggle = page.getByRole('button', { name: /来源目录/ });
  const checkbox = page.getByRole('checkbox', { name: prsSource, exact: true });
  if (!(await checkbox.isVisible())) await sourcesToggle.click();
  const started = Date.now();
  // 37 MB 的 f0aca373 分段导入：导入期间（PUT /api/sources 发出到返回）服务端照常响应其他请求。
  // 一次读完时事件循环被占住，导入期间发出的请求都在导入结束后才返回
  const putSent = page.waitForRequest(
    (r) => r.method() === 'PUT' && r.url().endsWith('/api/sources'),
  );
  await checkbox.click();
  const put = await putSent;
  const answeredAt: number[] = [];
  const probe = (async () => {
    for (let done = false; !done; done = put.timing().responseEnd > 0) {
      expect((await request.get('/api/health')).ok()).toBe(true);
      answeredAt.push(Date.now());
    }
  })();
  if ((await put.response()) === null) throw new Error('PUT /api/sources 没有响应');
  await probe;
  const { startTime, responseEnd } = put.timing();
  const importedAt = startTime + responseEnd;
  console.log(
    `导入 ${String(Math.round(responseEnd))} ms，导入期间返回的请求 ${String(answeredAt.filter((t) => t < importedAt).length)} 个`,
  );
  expect(answeredAt.filter((t) => t < importedAt).length).toBeGreaterThan(0);
  await expect(page.getByTestId('import-result')).toContainText('已导入', { timeout: 120_000 });
  const row = page.getByTestId('session-row').filter({ hasText: prsSession.slice(0, 8) });
  await row.getByRole('link').click();
  const ic = page.getByTestId('workflow-ic');
  await expect(ic.getByTestId('cycles-ic').getByRole('tab')).toHaveCount(3);
  console.log(`f0aca373 勾选来源到阶段图出现：${String(Date.now() - started)} ms`);

  const lfg = page.getByTestId('workflow-lfg');
  await expect(lfg.getByTestId('cycles-lfg').getByRole('tab')).toHaveText(/第 1 轮 · \/interview/);
  await expect(lfg.getByTestId('stage-interview')).toHaveAttribute('data-status', 'done');
  await expect(lfg.getByTestId('stage-research')).toHaveAttribute('data-status', 'not-reached');

  // 第 1 轮（PR #72）：open-pr #549、fix-pr #557
  const tabs = ic.getByTestId('cycles-ic').getByRole('tab');
  await expect(tabs.nth(0)).toContainText('#549 – #791');
  await expect(tabs.nth(1)).toContainText('#792 – #1142');
  await expect(tabs.nth(2)).toContainText('#1143 – #1230');
  await expect(ic.getByTestId('stage-open-pr')).toHaveAttribute('data-status', 'done');
  await expect(ic.getByTestId('stage-fix-pr')).toHaveAttribute('data-status', 'done');
  await expect(ic.getByTestId('stage-fix-pr').getByTestId('stage-entries')).toHaveText('1 轮');
  await page.screenshot({ path: `${shots}/w25-session-ic-lfg.png`, animations: 'disabled' });

  // 第 2 轮（PR #77）：没有调用 fix-pr
  await tabs.nth(1).click();
  await expect(ic.getByTestId('stage-open-pr')).toHaveAttribute('data-status', 'done');
  await expect(ic.getByTestId('stage-fix-pr')).toHaveAttribute('data-status', 'not-reached');
  await ic.screenshot({ path: `${shots}/w25-session-ic-pr77.png`, animations: 'disabled' });

  // 第 3 轮（PR #78）：session 停在 fix-pr
  await tabs.nth(2).click();
  await expect(ic.getByTestId('stage-fix-pr')).toHaveAttribute('data-status', 'active');
  await ic.getByTestId('stage-fix-pr').click();
  const detail = page.getByTestId('stage-detail');
  await expect(detail.getByTestId('stage-entries')).toHaveText('修复 1 轮');
  await expect(detail.getByTestId('stage-evidence')).toContainText(
    'Skill: fix-pr txehq/txe-workflow#78',
  );
  await expect(detail.getByTestId('stage-evidence')).toContainText('#1154');
  await page.screenshot({ path: `${shots}/w25-session-fix-pr.png`, animations: 'disabled' });
});
