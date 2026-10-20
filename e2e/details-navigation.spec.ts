import { expect, test } from './test.js';
import {
  api,
  f0,
  importTxeWorkflowSession,
  lfgRun,
  runSessions,
  shots,
  type StageView,
  visibleSeqs,
} from './details-helpers.js';

// 详情页中阶段与请求明细、对话区与请求明细之间的跳转
test.describe.configure({ mode: 'serial' });
test.setTimeout(10 * 60_000);

let lfgSession = '';

test.beforeAll(async ({ request }) => {
  await importTxeWorkflowSession(request);
  ({ lfgSession } = await runSessions(request));
});

test('Runs 详情：点击阶段后请求明细只含该阶段，再点恢复，"显示全部"恢复', async ({
  page,
  request,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  const run = (await (await request.get(`${api}/runs/${lfgRun}`)).json()) as {
    stages: { workflows: { workflow: string; cycles: { stages: StageView[] }[] }[] };
  };
  const research = run.stages.workflows
    .find((b) => b.workflow === 'lfg')
    ?.cycles[0]?.stages.find((s) => s.stage === 'research');
  if (research?.startSeq == null || research.endSeq == null) throw new Error('research 没有区间');

  await page.goto(`/runs/${lfgRun}`);
  const requests = page.locator('#run-requests');
  await expect(requests.getByTestId('timeline')).toBeVisible();
  await expect(requests.getByTestId('stage-requests')).toHaveCount(0);
  expect(Math.min(...(await visibleSeqs(page)))).toBe(0);

  const stages = page.getByTestId('run-stages');
  await stages.getByTestId('stage-research').click();
  const filtered = requests.getByTestId('stage-requests');
  await expect(filtered.getByRole('heading', { level: 2 })).toHaveText('/lfg · research');
  await expect(filtered).toContainText(
    `主 session 请求 #${String(research.startSeq)} – #${String(research.endSeq)}`,
  );
  await expect(requests.getByTestId('request-row').first()).toBeVisible();
  const seqs = await visibleSeqs(page);
  expect(seqs.length).toBeGreaterThan(0);
  for (const seq of seqs) {
    expect(seq).toBeGreaterThanOrEqual(research.startSeq);
    expect(seq).toBeLessThanOrEqual(research.endSeq);
  }
  await filtered.getByRole('heading', { level: 2 }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/w20-run-stage-filter.png`, animations: 'disabled' });

  // 再次点击同一阶段恢复全部
  await stages.getByTestId('stage-research').click();
  await expect(requests.getByTestId('stage-requests')).toHaveCount(0);
  await expect(requests.getByTestId('timeline')).toBeVisible();
  expect(Math.min(...(await visibleSeqs(page)))).toBe(0);

  // "显示全部"恢复全部
  await stages.getByTestId('stage-plan').click();
  await expect(filtered.getByRole('heading', { level: 2 })).toHaveText('/lfg · plan');
  await filtered.getByRole('button', { name: '显示全部' }).click();
  await expect(requests.getByTestId('stage-requests')).toHaveCount(0);
  expect(Math.min(...(await visibleSeqs(page)))).toBe(0);
});

test('Sessions 详情：对话区显示问答，点击跳到请求明细中的那一行', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/sessions/${f0}`);
  const conversation = page.getByTestId('conversation');
  await expect(conversation.getByTestId('message-user').first()).toContainText(
    '读一下这个项目，分析什么workflow',
  );
  await expect(conversation.getByTestId('message-agent').first()).toContainText('读完了');
  await expect(conversation.getByTestId('message-question')).toHaveCount(7);
  await expect(conversation.getByTestId('message-notice').first()).toBeVisible();

  // 有回答的 AskUserQuestion：选中的选项标出
  const question = conversation
    .getByTestId('message-question')
    .filter({ hasText: '装进哪些 agent' });
  await expect(question.locator('[data-picked="true"]').first()).toHaveText(/三个都装/);
  await question.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${shots}/w20-session-conversation.png`, animations: 'disabled' });

  // 点击跳到那一条请求，并展开 AskUserQuestion
  const jump = question.getByTestId('conversation-jump');
  const seq = (await jump.textContent()) ?? '';
  await jump.click();
  const focused = page.locator('[data-testid="request-row"][data-focused="true"]');
  await expect(focused).toHaveCount(1);
  await expect(focused.locator('header')).toContainText(seq);
  await expect(focused.getByTestId('tool-call-detail')).toContainText('三个都装');
  await expect(focused).toBeInViewport();

  // /interview 的用户消息跳到它触发的请求
  const interview = conversation.getByTestId('message-user').filter({ hasText: /^.*\/interview$/ });
  await interview.first().scrollIntoViewIfNeeded();
  const interviewSeq =
    (await interview.first().getByTestId('conversation-jump').textContent()) ?? '';
  await interview.first().getByTestId('conversation-jump').click();
  await expect(focused.locator('header')).toContainText(interviewSeq);
  await expect(focused).toBeInViewport();
});

test('Sessions 详情：选中某个阶段时从对话区跳转，先恢复全部请求再定位', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/sessions/${lfgSession}`);
  const conversation = page.getByTestId('conversation');
  await expect(conversation.getByTestId('message-user').first()).toContainText('/lfg 做一个计算器');
  await page.getByTestId('workflow-lfg').getByTestId('stage-research').click();
  await expect(page.getByTestId('stage-requests')).toBeVisible();
  // 同意计划的回答在 plan 阶段，不在 research 的请求中
  const answer = conversation
    .getByTestId('message-user')
    .filter({ hasText: '可以，这个计划我看了' });
  const jump = answer.getByTestId('conversation-jump');
  const seq = (await jump.textContent()) ?? '';
  await jump.click();
  await expect(page.getByTestId('stage-requests')).toHaveCount(0);
  const focused = page.locator('[data-testid="request-row"][data-focused="true"]');
  await expect(focused).toHaveCount(1);
  await expect(focused.locator('header')).toContainText(seq);
  await expect(focused).toBeInViewport();
});
