import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from './test.js';
import { analysisWorkflowServerPort } from '../ports.js';

// 分析由 workflow session-analysis 驱动（Contracts 19.2、19.3），基础档：数据由 prepare-analysis-workflow-e2e 每次重建
// （一轮的短 session cfa31f10 绑定到 workflow secret-keeper 的初稿，session-analysis 的基线与派生的"只看失败"，
// 一次成功的分析作为测试数据）。服务端不调用模型；Codex 是替身命令，skill 来源是本地 git 仓库
const api = `http://127.0.0.1:${String(analysisWorkflowServerPort)}/api`;
const shots = '.work/screenshots';
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
  const saved = bar.getByTestId('codex-draft-saved');
  await expect(saved).toContainText(`Codex ${draftId}`, { timeout: 60_000 });
  await page.screenshot({ path: `${shots}/w45-saved.png`, animations: 'disabled' });
  const result = (await (await request.get(`${api}/workflow-drafts/${draftId}`)).json()) as {
    savedWorkflowId: string;
  };
  expect(result.savedWorkflowId).toBe('secret-keeper');

  // 结束这一项的 Codex 进程（替身）
  const stopped = await request.post(`${api}/live/${liveId}/stop`);
  expect([200, 409]).toContain(stopped.status());
});
