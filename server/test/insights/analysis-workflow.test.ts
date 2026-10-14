import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { parse, stringify } from 'yaml';
import { bindLiveSession } from '../../src/bindings/index.js';
import { config } from '../../src/config.js';
import { openDatabase } from '../../src/db/index.js';
import { analyses, analysisFindings, type AnalysisReport } from '../../src/db/schema.js';
import { createDrafts } from '../../src/drafts/index.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import { ensureAnalysisBaseline } from '../../src/insights/baseline.js';
import { analysisLayout, createInsights, newAnalysisId } from '../../src/insights/index.js';
import { validateReport } from '../../src/insights/validate.js';
import { createLive } from '../../src/live/index.js';
import { createSettingsStore } from '../../src/runs/settings.js';
import { createVariants } from '../../src/variants/index.js';
import { listSkillFiles } from '../../src/variants/skills.js';
import { analysisBaselineSrc, createWorkflows, loadWorkflow } from '../../src/workflows/index.js';
import { testCodex } from '../helpers/codex.js';
import { makeSkillSources } from '../helpers/codex-skills.js';
import { testRepos } from '../helpers/local-repos.js';

// 基础档（Contracts 19.2、19.3）：session-analysis 的定义与基线 variant 在启动时写入并构建；引擎按所选 variant 的 skill
// 生成每个阶段的调用参数（不启动引擎）；交给 Codex 优化时分析目录中 optimize/ 的生成；保存为原 workflow 的新 variant
// 与新 workflow 两条路径（测试代码直接改 optimize/ 中的文件后保存，Codex 是替身命令，skill 来源是本地 git 仓库）
const dataDir = path.join(config.repoRoot, '.work', 'test-data');
const dbFile = path.join(config.repoRoot, '.work', 'test-db', `${randomUUID()}.sqlite`);
const db = openDatabase(dbFile, config.migrationsDir);
const variants = createVariants({
  db,
  dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});
const live = createLive({
  db,
  variants,
  settings: createSettingsStore(db),
  vaultDir: config.vaultDir,
  product: config.evalProduct,
  liveDir: config.liveDir,
  dataDir,
  serverUrl: () => 'http://127.0.0.1:1',
  localHome: path.join(config.dataDir, 'home'),
  repos: testRepos(),
  codex: testCodex(),
  claudeBin: config.claudeBin,
  autoStop: { idleMs: config.liveAutoStopMs, graceMs: config.liveStopGraceMs },
});
const work = path.join(config.repoRoot, '.work', 'test-analysis-workflow', randomUUID());
const drafts = createDrafts({
  db,
  variants,
  live,
  draftsDir: config.workflowDraftsDir,
  dataDir,
  skillSources: makeSkillSources(path.join(work, 'skill-sources')),
});
const insights = createInsights({ db, variants, dataDir });
const workflows = createWorkflows({ db, variants });
const marker = randomUUID().slice(0, 6);
const createdVariants: string[] = [];
const createdAnalyses: string[] = [];

afterAll(async () => {
  await live.shutdown();
  db.$client.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  for (const id of createdVariants) {
    fs.rmSync(path.join(dataDir, 'variants', id), { recursive: true, force: true });
  }
  for (const id of createdAnalyses) {
    fs.rmSync(analysisLayout(dataDir, id).dir, { recursive: true, force: true });
  }
  fs.rmSync(work, { recursive: true, force: true });
});

const baseline = await ensureAnalysisBaseline(db, variants);
createdVariants.push(baseline.id);
const STAGES = [
  'process-adherence',
  'plan-adherence',
  'failures',
  'repeated-work',
  'token-waste',
  'time-waste',
  'user-interaction',
  'output-quality',
  'request-conflicts',
  'synthesize',
];

// 一轮的短 session（"请记住暗号"），作为 Live 中某个 variant 的 session 绑定到它
const SESSION = 'cfa31f10-e280-4908-bcf7-cbe9b00fbe53';
const sessionFile = path.join(work, 'sessions', `${SESSION}.jsonl`);
fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
fs.copyFileSync(
  path.join(config.repoRoot, 'server/test/fixtures/live', `${SESSION}.jsonl`),
  sessionFile,
);
ingestFile(db, sessionFile);

// 被分析的 workflow：从空白新建（自有管理器），第一个 variant 构建后绑定 session
const flowId = `w45-flow-${marker}`;
const stepId = `w45-step-${marker}`;
workflows.create({
  id: flowId,
  name: `W45 ${marker}`,
  description: '',
  definition: { id: flowId, name: `W45 ${marker}`, stages: [{ id: stepId }] },
});
const analysed = variants.list().find((v) => v.workflowId === flowId);
if (analysed === undefined) throw new Error(`workflow ${flowId} 没有建出初稿`);
const analysedId = analysed.id;
createdVariants.push(analysed.id);
await variants.build(analysed.id);
bindLiveSession(db, dataDir, SESSION, analysed.id);

describe('session-analysis workflow（Contracts 19.2）', () => {
  test('启动时写入定义并建出基线：小阶段即九个方面加 synthesize，skill 与仓库一致，构建通过后冻结', async () => {
    expect(loadWorkflow(db, 'session-analysis').stages.map((s) => s.id)).toEqual(STAGES);
    expect(baseline).toMatchObject({
      workflowId: 'session-analysis',
      name: '基线',
      parentId: null,
      buildStatus: 'built',
      status: 'frozen',
    });
    expect(baseline.builtHash).toBe(baseline.skillsHash);
    expect(variants.buildLog(baseline.id)).toContain('[own]');
    const files = listSkillFiles(analysisBaselineSrc);
    expect(variants.listFiles(baseline.id).map((f) => f.path)).toEqual(files);
    // 入口、九个方面、synthesize 与供优化用的 optimize-from-report 都装进了 variant 自己的配置目录
    const installed = path.join(variants.runtimeEnv(baseline.id).env.CLAUDE_CONFIG_DIR, 'skills');
    expect(fs.readdirSync(installed).sort()).toEqual(
      ['session-analysis', ...STAGES, 'optimize-from-report'].sort(),
    );
    // 再次启动不重复建
    expect((await ensureAnalysisBaseline(db, variants)).id).toBe(baseline.id);
    expect(insights.defaults().analysisVariantId).toBe(baseline.id);
    expect(insights.analysisVariants().map((v) => v.id)).toEqual([baseline.id]);
  });

  test('引擎按所选 variant 的 skill 生成每个阶段的调用参数：派生的 variant 改了 skill，进程读到的就是改过的', async () => {
    const derived = variants.derive(baseline.id, { name: `W45 分析 ${marker}` });
    createdVariants.push(derived.id);
    const changed = '\n只看第一轮。\n';
    variants.writeFile(
      derived.id,
      'skills/failures/SKILL.md',
      variants.readFile(derived.id, 'skills/failures/SKILL.md') + changed,
    );
    await variants.build(derived.id);

    const claude = insights.plan({
      sessionIds: [SESSION],
      engine: 'claude',
      model: 'claude-opus-5-5',
      analysisVariantId: derived.id,
    });
    expect(claude.map((p) => p.key)).toEqual(STAGES);
    const home = variants.runtimeEnv(derived.id).env.CLAUDE_CONFIG_DIR;
    for (const p of claude) {
      expect(p.prompt).toBe(`/session-analysis ${p.key}`);
      expect(p.command.args).toEqual([
        'claude',
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        'bypassPermissions',
        '--model',
        'claude-opus-5-5',
        p.prompt,
      ]);
      expect(p.command.env.CLAUDE_CONFIG_DIR).toBe(home);
      expect(p.profile).toContain(home);
    }
    expect(
      fs.readFileSync(path.join(claude[0]?.skillsDir ?? '', 'failures/SKILL.md'), 'utf8'),
    ).toContain(changed);

    const codex = insights.plan({
      sessionIds: [SESSION],
      engine: 'codex',
      model: 'gpt-test',
      analysisVariantId: derived.id,
    });
    expect(codex.map((p) => [p.prompt, p.command.args.slice(0, 2)])).toEqual(
      STAGES.map((s) => [`$session-analysis ${s}`, ['codex', 'exec']]),
    );
    // Codex 从分析目录的 .agents/skills 加载这个 variant 的 skill
    expect(
      fs.readFileSync(path.join(codex[0]?.skillsDir ?? '', 'failures/SKILL.md'), 'utf8'),
    ).toContain(changed);
    expect(codex[0]?.skillsDir).toMatch(/\/analyses\/a-\d{8}-[a-z0-9]{6}\/\.agents\/skills$/);
    createdAnalyses.push(path.basename(path.dirname(path.dirname(codex[0]?.skillsDir ?? ''))));

    // 默认用基线；不属于 session-analysis 的 variant 不能用来分析
    expect(
      insights.plan({ sessionIds: [SESSION], engine: 'claude' })[0]?.command.env.CLAUDE_CONFIG_DIR,
    ).toBe(variants.runtimeEnv(baseline.id).env.CLAUDE_CONFIG_DIR);
    expect(() =>
      insights.plan({ sessionIds: [SESSION], engine: 'claude', analysisVariantId: analysed.id }),
    ).toThrow(`分析只能用 session-analysis 的 variant`);
  });

  test('report.json 的校验：格式不对或 findingIds 不存在时以原文失败', () => {
    const file = path.join(work, 'report.json');
    const report: AnalysisReport = {
      summary: '只有一轮',
      goal: '记住暗号',
      outcome: 'achieved',
      topIssues: [{ title: '没有问题', findingIds: ['failures-1'], impact: '无' }],
      workflowChanges: [],
    };
    fs.writeFileSync(file, JSON.stringify(report));
    expect(validateReport(file, new Set(['failures-1']))).toEqual(report);
    expect(() => validateReport(file, new Set())).toThrow(
      'report.json 校验失败：findingIds 不存在：failures-1',
    );
    fs.writeFileSync(file, JSON.stringify({ ...report, outcome: 'done' }));
    expect(() => validateReport(file, new Set(['failures-1']))).toThrow('report.json 的格式不对');
  });
});

// 一次成功的分析（测试数据）：报告与一条发现，分析用的是基线
function succeededAnalysis(): string {
  const id = newAnalysisId();
  createdAnalyses.push(id);
  db.insert(analyses)
    .values({
      id,
      engine: 'claude',
      model: 'claude-opus-5-5',
      variantId: analysedId,
      analysisVariantId: baseline.id,
      sessionIds: [SESSION],
      status: 'succeeded',
      steps: [],
      report: {
        summary: '一轮对话就记住了暗号。',
        goal: '记住暗号',
        outcome: 'achieved',
        topIssues: [],
        workflowChanges: [],
      },
    })
    .run();
  db.insert(analysisFindings)
    .values({
      analysisId: id,
      findingId: 'process-adherence-1',
      aspect: 'process-adherence',
      title: '没有进入阶段',
      stage: null,
      skill: null,
      severity: 'high',
      detail: '测试',
      evidence: [{ sessionId: SESSION, seq: 1, quote: '记住了' }],
    })
    .run();
  // 成功的分析在分析目录中留下修改建议的结果（这里没有修改建议）
  const dirs = analysisLayout(dataDir, id);
  fs.mkdirSync(dirs.dir, { recursive: true });
  fs.writeFileSync(dirs.proposals, '[]\n');
  return id;
}

async function openOptimize(analysisId: string) {
  const { draft, live: item } = drafts.openOptimize(analysisId);
  await drafts.prepare(draft.id);
  const ready = drafts.get(draft.id);
  expect(ready.status, ready.error ?? '').toBe('open');
  return { draft: ready, live: item };
}

describe('交给 Codex 优化（Contracts 19.3）', { timeout: 120_000 }, () => {
  test('分析目录中的 optimize/、PLATFORM.md、skill 与初始消息', async () => {
    const analysisId = succeededAnalysis();
    const { draft, live: item } = await openOptimize(analysisId);
    const dir = analysisLayout(dataDir, analysisId).dir;
    expect(draft).toMatchObject({
      mode: 'optimize',
      workflowId: flowId,
      baseVariantId: analysed.id,
      analysisId,
      dir,
    });
    expect(item.cwd).toBe(dir);
    // optimize/src 是被分析 variant 的 src，optimize/workflow.yaml 是它所属 workflow 的定义（可以改）
    expect(listSkillFiles(path.join(dir, 'optimize/src'))).toEqual(
      variants.listFiles(analysed.id).map((f) => f.path),
    );
    expect(parse(fs.readFileSync(path.join(dir, 'optimize/workflow.yaml'), 'utf8'))).toEqual(
      loadWorkflow(db, flowId),
    );
    fs.accessSync(path.join(dir, 'optimize/workflow.yaml'), fs.constants.W_OK);
    const platform = fs.readFileSync(path.join(dir, 'PLATFORM.md'), 'utf8');
    expect(platform).toContain('这个 workflow 不用 wf');
    expect(platform).toContain('### variant 与 workflow 的界限');
    // 第 17 节的三个 skill 加上分析所用 variant 中的 optimize-from-report
    expect(fs.readdirSync(path.join(dir, '.agents/skills')).sort()).toEqual(
      ['find-skills', 'optimize-from-report', 'skill-creator', 'writing-for-agents'].sort(),
    );
    expect(
      fs.readFileSync(path.join(dir, '.agents/skills/optimize-from-report/SKILL.md'), 'utf8'),
    ).toBe(variants.readFile(baseline.id, 'skills/optimize-from-report/SKILL.md'));
    // 初始消息：报告的总结与发现的条数，指向 output/ 与 optimize/
    const prompt = live.get(item.id).input;
    expect(prompt).toContain('一轮对话就记住了暗号。');
    expect(prompt).toContain('发现 1 条（high 1、medium 0、low 0）');
    expect(prompt).toContain('optimize/src/skills/');
    expect(insights.detail(analysisId).optimizeDrafts).toEqual([{ id: draft.id, liveId: item.id }]);
  });

  test('workflow.yaml 没有改：保存为原 workflow 的新 variant，parent 为被分析的 variant，记录分析', async () => {
    const analysisId = succeededAnalysis();
    const { draft } = await openOptimize(analysisId);
    const skill = path.join(draft.dir, 'optimize/src/skills', stepId, 'SKILL.md');
    fs.appendFileSync(skill, '\n先读输入再回答。\n');
    // 保存前的改动预览（Contracts 21.3）：optimize/src 相对被分析的 variant
    const preview = drafts.diff(draft.id, undefined);
    expect(preview.base).toEqual({ id: analysed.id, name: analysed.name });
    expect(preview.files.map((f) => [f.path, f.status])).toEqual([
      [`skills/${stepId}/SKILL.md`, 'modified'],
    ]);
    expect(preview.files[0]?.oldContent).toBe(
      variants.readFile(analysed.id, `skills/${stepId}/SKILL.md`),
    );
    expect(preview.files[0]?.patch).toContain('\n+\n+先读输入再回答。\n');
    // 保存到原 workflow：新建 variant 或覆盖其中的 variant（Contracts 19.3）
    const plan = drafts.savePlan(draft.id);
    expect(plan).toMatchObject({
      kind: 'variant',
      workflowId: flowId,
      parent: { id: analysed.id, name: analysed.name },
    });
    expect(() =>
      drafts.save(draft.id, {
        target: { kind: 'new', name: `优化 ${marker}`, description: '' },
      }),
    ).toThrow('variant 的描述不能为空');
    const saved = drafts.save(draft.id, {
      target: { kind: 'new', name: `优化 ${marker}`, description: '先读输入再回答' },
    });
    const v = variants.get(saved.savedVariantId ?? '');
    createdVariants.push(v.id);
    // 保存不构建，状态为 draft
    expect(v).toMatchObject({
      workflowId: flowId,
      parentId: analysed.id,
      analysisId,
      draftId: draft.id,
      name: `优化 ${marker}`,
      description: '先读输入再回答',
      status: 'draft',
      buildStatus: 'none',
      builtHash: null,
    });
    expect(fs.existsSync(variants.layout(v.id).dist)).toBe(false);
    expect(saved.savedWorkflowId).toBe(flowId);
    expect(variants.readFile(v.id, `skills/${stepId}/SKILL.md`)).toContain('先读输入再回答。');
  });

  test('workflow.yaml 改了：保存为新 workflow 与它的第一个 variant；再次保存时定义必须与已保存的相同', async () => {
    const analysisId = succeededAnalysis();
    const { draft } = await openOptimize(analysisId);
    const newId = `w45-new-${marker}`;
    const definition = {
      id: newId,
      name: `W45 新 ${marker}`,
      stages: [{ id: stepId }, { id: `w45-check-${marker}` }],
    };
    fs.writeFileSync(path.join(draft.dir, 'optimize/workflow.yaml'), stringify(definition));
    const skills = path.join(draft.dir, 'optimize/src/skills');
    fs.renameSync(path.join(skills, flowId), path.join(skills, newId));
    const entry = path.join(skills, newId, 'SKILL.md');
    fs.writeFileSync(
      entry,
      fs.readFileSync(entry, 'utf8').replace(`name: ${flowId}`, `name: ${newId}`),
    );
    const check = path.join(skills, `w45-check-${marker}`);
    fs.mkdirSync(check);
    fs.writeFileSync(
      path.join(check, 'SKILL.md'),
      `---\nname: w45-check-${marker}\ndescription: 检查回答\n---\n\n检查回答是否只有"记住了"。\n`,
    );
    // 第一次保存为新 workflow：workflow 与第一个 variant 的名字与描述都必填
    expect(drafts.savePlan(draft.id)).toEqual({
      kind: 'new-workflow',
      workflowId: newId,
      workflowName: definition.name,
      workflowDescription: `由 Codex 按分析 ${analysisId} 的报告，从 workflow ${flowId} 改出`,
      variantName: '初稿',
    });
    const first = { kind: 'new' as const, name: '初稿', description: '加上检查阶段' };
    expect(() => drafts.save(draft.id, { target: first })).toThrow(
      `第一次保存为新 workflow ${newId}，要填 workflow 的名字与描述`,
    );
    expect(() =>
      drafts.save(draft.id, { target: first, workflow: { name: '  ', description: 'x' } }),
    ).toThrow('workflow 的名字不能为空');
    expect(workflows.list().some((w) => w.id === newId)).toBe(false);
    const saved = drafts.save(draft.id, {
      target: first,
      workflow: { name: `W45 新流程 ${marker}`, description: '回答后再检查一遍' },
    });
    const v = variants.get(saved.savedVariantId ?? '');
    createdVariants.push(v.id);
    expect(saved.savedWorkflowId).toBe(newId);
    expect(loadWorkflow(db, newId)).toEqual({ ...definition, name: `W45 新流程 ${marker}` });
    expect(workflows.get(newId)).toMatchObject({
      evalKind: null,
      description: '回答后再检查一遍',
    });
    expect(v).toMatchObject({
      workflowId: newId,
      name: '初稿',
      description: '加上检查阶段',
      parentId: null,
      analysisId,
      buildStatus: 'none',
    });

    // 再次保存：入口与小阶段不变时（名字可以不同）保存到新 workflow 中；改了小阶段时以原文失败
    expect(drafts.savePlan(draft.id)).toMatchObject({ kind: 'variant', workflowId: newId });
    const again = drafts.save(draft.id, {
      target: { kind: 'new', name: '第二稿', description: '同样的阶段' },
    });
    createdVariants.push(again.savedVariantId ?? '');
    expect(variants.get(again.savedVariantId ?? '')).toMatchObject({
      workflowId: newId,
      name: '第二稿',
      parentId: null,
    });
    fs.writeFileSync(
      path.join(draft.dir, 'optimize/workflow.yaml'),
      stringify({ ...definition, stages: [...definition.stages, { id: 'publish' }] }),
    );
    expect(() =>
      drafts.save(draft.id, { target: { kind: 'new', name: '第三稿', description: 'x' } }),
    ).toThrow(`workflow.yaml 与已保存的 workflow ${newId} 的定义不同`);
  });

  test('按 hunk 接受后另存为 variant（Contracts 15.3）：名字与描述必填，不构建，记录 parent 与分析', () => {
    const analysisId = succeededAnalysis();
    const file = `skills/${stepId}/SKILL.md`;
    const original = variants.readFile(analysed.id, file);
    const files = [{ path: file, content: `${original}\n先读输入再回答。\n` }];
    fs.writeFileSync(
      analysisLayout(dataDir, analysisId).proposals,
      `${JSON.stringify([{ path: file, original, proposed: files[0]?.content, hunks: [] }])}\n`,
    );
    expect(() =>
      insights.saveVariant(analysisId, { name: ' ', description: '先读输入', files }),
    ).toThrow('variant 的名字不能为空');
    expect(() =>
      insights.saveVariant(analysisId, { name: `另存 ${marker}`, description: '', files }),
    ).toThrow('variant 的描述不能为空');
    const v = insights.saveVariant(analysisId, {
      name: `另存 ${marker}`,
      description: '先读输入',
      files,
    });
    createdVariants.push(v.id);
    expect(v).toMatchObject({
      workflowId: flowId,
      parentId: analysed.id,
      analysisId,
      description: '先读输入',
      status: 'draft',
      buildStatus: 'none',
      builtHash: null,
    });
    expect(variants.readFile(v.id, file)).toContain('先读输入再回答。');
    expect(() =>
      insights.saveVariant(analysisId, { name: `另存 ${marker}`, description: '再存', files }),
    ).toThrow(`名称已被使用：另存 ${marker} (${flowId})`);
  });

  test('分析没有成功完成时不能交给 Codex', () => {
    const analysisId = succeededAnalysis();
    db.update(analyses)
      .set({ status: 'failed', report: null })
      .where(eq(analyses.id, analysisId))
      .run();
    expect(() => drafts.openOptimize(analysisId)).toThrow(
      `分析 ${analysisId} 还没有成功完成，没有报告可以交给 Codex`,
    );
  });
});
