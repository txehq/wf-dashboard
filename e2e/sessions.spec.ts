import fs from 'node:fs';
import path from 'node:path';
import { samplesDir } from '../server/test/stages/samples.js';
import { fixtureCwd } from './fixture-cwd.js';
import { e2eCodexHome } from './services.js';
import { expect, type Page, test } from './test.js';

// 真实数据（server/scripts/prepare-sessions-e2e.ts 每次重建，Contracts 25.1、25.4）：
// - 两个从 txe-workflow 9f2bed6 导入的基线 variant「e2e 基线」（lfg、ic）。ic 的配置目录中有 ic run 40f6915a
//   （/ic TXE-3764，claim、readiness、implement、open-pr 都由 Skill 调用开始，停在 open-pr）与本机的 f0aca373
//   （/interview 一轮 lfg，Skill open-pr 开启的三轮 ic）；lfg 的配置目录中有 lfg run dqva52（四个阶段都由 Skill 调用开始，
//   含子代理）。这个数据库中没有 run 行：三个 session 都按离线 session 划分，最后一个阶段为 active
// - 本机配置（服务端的 WFD_CLAUDE_PROJECTS）中一个短 session「请记住暗号」，不显示 workflow 与阶段
// - 本机 Codex（WFD_CODEX_HOME）：真实 rollout 的样本，与它的一份已归档的副本
const projects = path.resolve(import.meta.dirname, '../.work/e2e/projects');
const localSource = path.join(projects, '-e2e-local');
const localSession = 'cfa31f10-e280-4908-bcf7-cbe9b00fbe53';
const icSession = '40f6915a-cd31-4312-866c-dcb377515c42';
const lfgSession = '0188c133-3e7b-4592-a963-fc717cf283de';
const prsSession = 'f0aca373-863f-4d62-babd-f48055092328';
const codexSession = '01a106dd-2ba7-7e71-8490-0e170a634111';
const codexArchived = '01a106dd-2ba7-7e71-8490-0e170a634222';
const codexCwd = '/Users/tester/install-test2/.install/codex-probe';
// test/fixtures/samples 中的真实 session（解压到 .work/samples）：f0aca373 在这份数据中，9f4adf2d 不在
const prsSample = path.join(samplesDir, '-Users-linhaoz-Project-txe-txe-workflow', prsSession);
const chunked = {
  id: '9f4adf2d-0730-4214-994a-4fba7f7b9161',
  sample: path.join(
    samplesDir,
    '-Users-linhaoz-Project-txe-txe-workflow',
    '9f4adf2d-0730-4214-994a-4fba7f7b9161',
  ),
};
const shots = '.work/screenshots';
// 使用手册的截图（两种窗口大小），复制进 vault 的 assets
const guideShots = '.work/guide/screenshots';
const sizes = [
  { width: 1280, height: 800 },
  { width: 1600, height: 1000 },
] as const;

async function guideShot(page: Page, name: string) {
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.screenshot({
      path: `${guideShots}/guide-${name}-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
}

const rowOf = (page: Page, id: string) =>
  page.locator(`[data-testid="session-row"][data-session="${id}"]`);
const panel = (page: Page) => page.getByTestId('import-panel');
// 第一列中某个 workflow 的组里的一个 variant 的配置（Contracts 25.1：按 workflow 分组，variant 显示自己的名字）
const configItem = (page: Page, workflow: string, label: string) =>
  panel(page)
    .getByRole('group', { name: workflow, exact: true })
    .getByTestId('import-config')
    .filter({ hasText: label });
const projectItem = (page: Page, cwd: string) =>
  panel(page).locator(`[data-testid="import-project"][data-cwd="${cwd}"]`);
const diskRow = (page: Page, id: string) =>
  panel(page).locator(`[data-testid="disk-session"][data-session="${id}"]`);
// 两个 session 的项目：fixture 中记下的工作目录
const localCwd = fixtureCwd(
  path.resolve(import.meta.dirname, `../server/test/fixtures/live/${localSession}.jsonl`),
);
const prsCwd = fixtureCwd(`${prsSample}.jsonl`);

test.describe.configure({ mode: 'serial' });
test.use({ viewport: { width: 1600, height: 1000 } });

test('Sessions：三列的点选与搜索，dashboard 自己的配置自动导入，清除后从上面重新导入，分段导入大的 session，管理表格的搜索与配置筛选', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  await page.goto('/sessions');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Sessions');
  const views = page.getByRole('radiogroup', { name: '视图' });
  await expect(views.getByRole('radio', { name: 'Claude Code' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // 第一列：本机配置在最前，其后按 workflow 分组列出全部 variant（同名的「e2e 基线」分在 lfg、ic 两组），各带磁盘上的
  // session 数；搜索配置名或 workflow 名
  await expect(panel(page).getByTestId('import-config').first()).toContainText('本机配置');
  await expect(configItem(page, 'ic', 'e2e 基线')).toContainText('2');
  await expect(configItem(page, 'lfg', 'e2e 基线')).toContainText('1');
  const configSearch = page.getByRole('searchbox', { name: '搜索配置' });
  await configSearch.fill('lfg');
  // 同一次 e2e 中别的文件可能在这份数据中另建 lfg 的 variant：只看剩下的都在 lfg 组中
  await expect(panel(page).getByTestId('import-config-group')).toHaveCount(1);
  await expect(panel(page).getByTestId('import-config-group')).toHaveAccessibleName('lfg');
  await expect(configItem(page, 'lfg', 'e2e 基线')).toBeVisible();
  await expect(
    panel(page).getByTestId('import-config').filter({ hasText: '本机配置' }),
  ).toHaveCount(0);
  await configSearch.fill('');
  await expect(configItem(page, 'ic', 'e2e 基线')).toBeVisible();
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.screenshot({
      path: `${shots}/w75-config-groups-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }
  await guideShot(page, 'w75-configs');

  // variant 的配置目录中的 session 由增量导入自动进入管理表格（37 MB 的 f0aca373 分段导入）；本机的没有导入
  for (const id of [icSession, lfgSession, prsSession])
    await expect(rowOf(page, id)).toBeVisible({ timeout: 120_000 });
  await expect(rowOf(page, localSession)).toHaveCount(0);
  await expect(page.getByTestId('session-pager-range')).toHaveText('共 3 个 session');

  // 本机配置：第二列是项目，第三列是项目中磁盘上的 session，勾选后导入
  await projectItem(page, localCwd).click();
  await expect(projectItem(page, localCwd)).toHaveAttribute('aria-current', 'true');
  const local = diskRow(page, localSession);
  await expect(local).toContainText('请记住暗号');
  await expect(local.getByTestId('disk-imported')).toHaveCount(0);
  await local.getByRole('checkbox').check();
  await expect(local.getByTestId('disk-change')).toHaveText('+ 导入');
  const confirm = panel(page).getByTestId('import-apply');
  await expect(confirm).toHaveText('应用：导入 1 个');
  await confirm.click();
  await expect(panel(page).getByTestId('import-result')).toHaveText('已导入 1 个');
  await expect(local.getByTestId('disk-imported')).toHaveText('已导入');
  await expect(rowOf(page, localSession)).toBeVisible();
  await expect(projectItem(page, localCwd)).toContainText('已导入 1 / 1');

  // 全部：四个 session；workflow 列只按 dashboard 记录的配置显示（variant 的 workflow，本机的没有）
  const detailJson = (await (await request.get(`/api/sessions/${icSession}`)).json()) as {
    requestCount: number;
  };
  await expect(rowOf(page, icSession)).toContainText('/ic TXE-3764');
  await expect(rowOf(page, icSession)).toContainText(String(detailJson.requestCount));
  await expect(rowOf(page, icSession).getByTestId('session-workflow')).toHaveText('/ic');
  await expect(rowOf(page, prsSession).getByTestId('session-workflow')).toHaveText('/ic');
  await expect(rowOf(page, lfgSession)).toContainText('/lfg 做一个计算器');
  await expect(rowOf(page, lfgSession).getByTestId('session-workflow')).toHaveText('/lfg');
  await expect(rowOf(page, localSession).getByTestId('session-workflow')).toHaveText('—');
  await expect(rowOf(page, localSession).getByTestId('session-variant')).toHaveText('—');
  // variant 配置下没有 run 的 f0aca373 自动绑定这个配置目录所属的 variant（Contracts 25.4）
  await expect(rowOf(page, prsSession).getByTestId('session-variant')).toHaveText('e2e 基线自动');
  await expect(page.locator('col[data-column="variant"]')).toHaveCount(1);
  await expect(page.getByTestId('session-pager-range')).toHaveText('共 4 个 session');

  // 管理表格：搜索、按配置筛选
  const search = page.getByRole('searchbox', { name: '搜索 session' });
  await search.fill('40f6915a');
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  await search.fill(`${lfgSession.slice(0, 8)}x`);
  await expect(page.getByText(`没有符合「${lfgSession.slice(0, 8)}x」的 session。`)).toBeVisible();
  await page.getByRole('button', { name: '清除搜索' }).click();
  await expect(page.getByTestId('session-row')).toHaveCount(4);
  const filter = page.getByTestId('session-config-filter');
  // 下拉中 variant 的配置同样按 workflow 分组
  await expect(filter.locator('optgroup[label="ic"] option')).toContainText(['e2e 基线']);
  const icOption = await filter
    .locator('optgroup[label="ic"] option', { hasText: 'e2e 基线' })
    .getAttribute('value');
  if (icOption === null) throw new Error('下拉中 ic 的「e2e 基线」没有 value');
  await filter.selectOption(icOption);
  await expect(page.getByTestId('session-row')).toHaveCount(2);
  await filter.selectOption({ label: '本机配置' });
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  // 只有本机的 session：workflow 与 variant 两列都为空，不显示
  await expect(page.locator('col[data-column="workflow"]')).toHaveCount(0);
  await expect(page.locator('col[data-column="variant"]')).toHaveCount(0);
  await filter.selectOption({ label: '全部配置' });
  await expect(page.getByTestId('session-row')).toHaveCount(4);
  await guideShot(page, 'w69-sessions');

  // 清除 f0aca373：从管理表格中隐藏，dashboard 中的数据与磁盘上的文件都保留；在 ic 配置下的第三列中不再是已导入
  await rowOf(page, prsSession).getByRole('checkbox').check();
  await page.getByTestId('selection-actions').getByTestId('session-clear').click();
  await expect(rowOf(page, prsSession)).toHaveCount(0);
  await configItem(page, 'ic', 'e2e 基线').click();
  await projectItem(page, prsCwd).click();
  const prs = diskRow(page, prsSession);
  await expect(prs.getByTestId('disk-imported')).toHaveCount(0);
  // 第三列的搜索：按 session id
  const diskSearch = page.getByRole('searchbox', { name: '搜索磁盘上的 session' });
  await diskSearch.fill(icSession.slice(0, 8));
  await expect(panel(page).getByTestId('disk-session')).toHaveCount(0);
  await diskSearch.fill(prsSession.slice(0, 8));
  await expect(panel(page).getByTestId('disk-session')).toHaveCount(1);
  // 等过一次增量导入（每 5 秒）：清除的仍不在管理表格中，详情照常
  await page.waitForTimeout(6000);
  await page.reload();
  await expect(page.getByTestId('session-pager-range')).toHaveText('共 3 个 session');
  expect((await request.get(`/api/sessions/${prsSession}`)).ok()).toBe(true);

  // 从上面重新勾选：回到管理表格（数据还在，不重新读取）
  await configItem(page, 'ic', 'e2e 基线').click();
  await projectItem(page, prsCwd).click();
  await diskRow(page, prsSession).getByRole('checkbox').check();
  await confirm.click();
  await expect(rowOf(page, prsSession)).toBeVisible();
  await expect(page.getByTestId('session-pager-range')).toHaveText('共 4 个 session');
  await expect(diskRow(page, prsSession).getByTestId('disk-imported')).toHaveText('已导入');
  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.screenshot({
      path: `${shots}/w69-sessions-${String(size.width)}.png`,
      animations: 'disabled',
    });
  }
  await page.setViewportSize({ width: 1600, height: 1000 });

  // 第一次导入一个没有导入过的 session（分段导入，每段 2 MB）：最短的超过一段的真实样本 9f4adf2d（主 jsonl 4.2 MB，
  // 三段），连同同名的子代理与 tool-results 目录复制到本机配置中，导入后可以读取详情。导入期间服务照常响应由
  // server/test/session-import-yield.test.ts 证明（服务与客户端在同一个进程中，结果只取决于事件循环的顺序）。之后用删除去掉它
  const bigDir = path.join(projects, '-e2e-chunked');
  fs.mkdirSync(bigDir, { recursive: true });
  const file = path.join(bigDir, `${chunked.id}.jsonl`);
  fs.copyFileSync(`${chunked.sample}.jsonl`, file);
  fs.cpSync(chunked.sample, path.join(bigDir, chunked.id), { recursive: true });
  const response = await request.post('/api/session-import', {
    data: { files: [file] },
    timeout: 120_000,
  });
  expect(response.status(), await response.text()).toBe(200);
  expect((await request.get(`/api/sessions/${chunked.id}`)).ok()).toBe(true);
  const deleted = await request.post('/api/sessions/delete', { data: { ids: [chunked.id] } });
  expect(deleted.status()).toBe(200);
  expect(fs.existsSync(file)).toBe(false);
  fs.rmSync(bigDir, { recursive: true });
  await page.reload();
  await expect(page.getByTestId('session-pager-range')).toHaveText('共 4 个 session');
});

test('variant 配置下的 session：详情、导入即有的阶段、进入阶段的调用、阶段请求、tool 调用与子代理', async ({
  page,
  request,
}) => {
  test.setTimeout(300_000);
  await page.goto(`/sessions/${icSession}`);
  const detailJson = (await (await request.get(`/api/sessions/${icSession}`)).json()) as {
    requestCount: number;
  };
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
  await rowOf(page, lfgSession).getByRole('link').click();
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

test('f0aca373：一轮 /interview 的 lfg 与三轮 ic，fix-pr 显示修复轮数', async ({ page }) => {
  await page.goto(`/sessions/${prsSession}`);
  const ic = page.getByTestId('workflow-ic');
  await expect(ic.getByTestId('cycles-ic').getByRole('tab')).toHaveCount(3);

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

test('本机配置的 session：对话与请求照常，没有 workflow、阶段与绑定', async ({ page }) => {
  await page.goto(`/sessions/${localSession}`);
  const summary = page.getByTestId('session-summary');
  await expect(summary.getByRole('heading', { level: 1 })).toContainText('请记住暗号');
  await expect(summary.getByTestId('session-config')).toHaveText('· 本机配置（不绑定 variant）');
  await expect(page.getByTestId('conversation')).toBeVisible();
  await expect(page.getByRole('region', { name: '全部请求' })).toBeVisible();
  await expect(page.getByTestId('session-binding')).toHaveCount(0);
  await expect(page.locator('[data-testid^="workflow-"]')).toHaveCount(0);
  await expect(page.getByTestId('outside-stats')).toHaveCount(0);
  await guideShot(page, 'w62-session-local');
});

test('Codex 视图：本机的项目按 rollout 的 cwd 列出，已归档的另列；删除的确认对话框', async ({
  page,
}) => {
  await page.goto('/sessions');
  await page
    .getByRole('radiogroup', { name: '视图' })
    .getByRole('radio', { name: 'Codex' })
    .click();
  // 选择记在 localStorage
  await page.reload();
  await expect(
    page.getByRole('radiogroup', { name: '视图' }).getByRole('radio', { name: 'Codex' }),
  ).toHaveAttribute('aria-checked', 'true');
  const project = projectItem(page, codexCwd);
  await expect(project).toContainText('codex-probe');
  await project.click();
  // sessions/ 与 archived_sessions/ 中的都列出，本页全选后导入
  await expect(panel(page).getByTestId('disk-session')).toHaveCount(2);
  await panel(page).getByTestId('import-select-page').check();
  await panel(page).getByTestId('import-apply').click();
  await expect(panel(page).getByTestId('import-result')).toHaveText('已导入 2 个');

  // 价格表中没有这个模型：只记 token，不显示花费；已归档的默认不列出
  const row = rowOf(page, codexSession);
  await expect(row).toContainText('Call the status tool of the wf-history MCP server');
  await expect(row.getByTestId('session-cost')).toHaveText('—');
  await expect(rowOf(page, codexArchived)).toHaveCount(0);
  await guideShot(page, 'w69-sessions-codex');

  // 显示已归档：只列已归档的，选中后为"恢复"
  await page.getByTestId('show-archived').check();
  const archived = rowOf(page, codexArchived);
  await expect(archived.getByTestId('session-archived')).toHaveText('已归档');
  await expect(page.getByTestId('session-row')).toHaveCount(1);
  await archived.getByRole('checkbox').check();
  const actions = page.getByTestId('selection-actions');
  await expect(actions.getByTestId('session-unarchive')).toBeVisible();
  await expect(actions.getByTestId('session-archive')).toHaveCount(0);
  await actions.getByRole('button', { name: '取消选择' }).click();
  await page.getByTestId('show-archived').uncheck();

  // 删除：确认对话框列出 rollout 的路径，由 codex delete 永久删除；取消后什么都不变
  await row.getByRole('checkbox').check();
  await expect(actions.getByTestId('session-archive')).toBeVisible();
  await expect(actions.getByTestId('session-clear')).toBeVisible();
  await actions.getByTestId('session-delete').click();
  const dialog = page.getByTestId('session-delete-dialog');
  const item = dialog.locator(`[data-session="${codexSession}"]`);
  await expect(item).toContainText('由 codex delete 永久删除');
  await expect(item).toContainText(
    path.join(
      e2eCodexHome,
      'sessions/2026/10/04',
      `rollout-2026-10-04T20-22-00-${codexSession}.jsonl`,
    ),
  );
  await expect(dialog.getByTestId('session-delete-confirm')).toBeEnabled();
  await guideShot(page, 'w69-delete-codex');
  await dialog.getByRole('button', { name: '取消' }).first().click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toBeVisible();
  await page
    .getByRole('radiogroup', { name: '视图' })
    .getByRole('radio', { name: 'Claude Code' })
    .click();
});

test('Claude Code 的删除：确认后 session 与磁盘上的文件一起删除，表格与上面的三列随之更新', async ({
  page,
}) => {
  await page.goto('/sessions');
  const row = rowOf(page, localSession);
  await row.getByRole('checkbox').check();
  await page.getByTestId('selection-actions').getByTestId('session-delete').click();
  const dialog = page.getByTestId('session-delete-dialog');
  const file = path.join(localSource, `${localSession}.jsonl`);
  await expect(dialog.locator(`[data-session="${localSession}"]`)).toContainText(file);
  await expect(dialog).not.toContainText('codex delete');
  await dialog.getByTestId('session-delete-confirm').click();
  await expect(dialog).toHaveCount(0);
  await expect(row).toHaveCount(0);
  expect(fs.existsSync(file)).toBe(false);
  await expect(projectItem(page, localCwd)).toHaveCount(0);
});

// W84（W82 的 bug 2）：各阶段花费与耗时的条形图画出条，条的长度与数值成比例。Sessions 详情中两栏，
// Live 终端旁的抽屉（默认 480 px 宽）中一栏；两种窗口大小
interface StageNumbers {
  status: string;
  stats: { costUsd: number; durationMs: number };
}
async function expectProportionalBars(
  chartsIn: ReturnType<Page['getByTestId']>,
  views: StageNumbers[],
) {
  const charts = chartsIn.getByTestId('stage-chart');
  await expect(charts).toHaveCount(2);
  const measures = [(v: StageNumbers) => v.stats.costUsd, (v: StageNumbers) => v.stats.durationMs];
  for (const [i, measure] of measures.entries()) {
    const values = views
      .filter((v) => v.status !== 'skipped' && v.status !== 'not-reached')
      .map(measure)
      .filter((n) => n > 0)
      .sort((a, b) => a - b);
    const widths = (
      await charts
        .nth(i)
        .locator('.recharts-bar-rectangle path')
        .evaluateAll((paths) => paths.map((p) => p.getBoundingClientRect().width))
    )
      .filter((w) => w > 0)
      .sort((a, b) => a - b);
    expect(widths).toHaveLength(values.length);
    const longest = widths.at(-1) ?? 0;
    const largest = values.at(-1) ?? 0;
    expect(longest).toBeGreaterThan(40);
    for (const [k, width] of widths.entries())
      expect(Math.abs(width / longest - (values[k] ?? 0) / largest) * longest).toBeLessThan(2);
  }
}

test('阶段的条形图：Sessions 详情与 Live 的抽屉中都画出条，长度与数值成比例', async ({
  page,
  request,
}) => {
  const report = (await (await request.get(`/api/sessions/${icSession}/stages`)).json()) as {
    workflows: { workflow: string; cycles: { stages: StageNumbers[] }[] }[];
  };
  const views = report.workflows.find((w) => w.workflow === 'ic')?.cycles[0]?.stages;
  if (views === undefined) throw new Error('没有 ic 的一轮');
  const imported = await request.post('/api/live/import', { data: { sessionIds: [icSession] } });
  expect(imported.status()).toBe(201);
  const [item] = (await imported.json()) as { id: string }[];
  if (item === undefined) throw new Error('没有导入的交互项');

  for (const size of sizes) {
    await page.setViewportSize(size);
    await page.goto(`/sessions/${icSession}`);
    const ic = page.getByTestId('workflow-ic');
    await expectProportionalBars(ic, views);
    await ic.screenshot({ path: `${shots}/w84-stage-bars-detail-${String(size.width)}.png` });

    await page.goto(`/live?item=${item.id}`);
    await page.getByTestId('toggle-side').click();
    const drawer = page.getByTestId('side-drawer');
    await expectProportionalBars(drawer, views);
    await page.screenshot({ path: `${shots}/w84-stage-bars-drawer-${String(size.width)}.png` });
  }
  await page.setViewportSize({ width: 1600, height: 1000 });
});
