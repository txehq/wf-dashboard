import fs from 'node:fs';
import path from 'node:path';
import { createTwoFilesPatch } from 'diff';
import { bindLiveSession } from '../src/bindings/index.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { analyses, analysisFindings, analysisPatches } from '../src/db/schema.js';
import { ingestFile } from '../src/ingest/ingest.js';
import { ensureAnalysisBaseline } from '../src/insights/baseline.js';
import { analysisLayout, newAnalysisId } from '../src/insights/index.js';
import { validatePatches } from '../src/insights/validate.js';
import { createVariants } from '../src/variants/index.js';
import { createWorkflows, loadWorkflow } from '../src/workflows/index.js';
import { makeSkillSources } from '../test/helpers/codex-skills.js';

// 用法：WFD_DATA_DIR=.work/e2e/analysis-workflow/data tsx scripts/prepare-analysis-workflow-e2e.ts <skill 来源目录>
// 分析由 workflow 驱动的基础档 e2e（Contracts 19.2、19.3）：每次删除重建。一轮的短 session cfa31f10 放在从空白新建的
// workflow 的初稿的配置目录中并绑定到它；建出 session-analysis 的基线与一个派生的分析方法；写入一次成功的分析（测试数据：
// 各阶段的状态与花费、每个方面一条发现、报告），供报告页与"交给 Codex 优化"使用。不调用任何模型

if (config.dataDir === path.join(config.repoRoot, 'data')) {
  throw new Error('WFD_DATA_DIR 未设置：e2e 数据目录不能是 data/');
}
const skillSourcesDir = process.argv[2];
if (skillSourcesDir === undefined) throw new Error('缺少参数：skill 来源目录');
fs.rmSync(config.dataDir, { recursive: true, force: true });
fs.mkdirSync(config.dataDir, { recursive: true });
makeSkillSources(path.resolve(skillSourcesDir));

const db = openDatabase(config.dbPath, config.migrationsDir);
const variants = createVariants({
  db,
  dataDir: config.dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});

const SESSION = 'cfa31f10-e280-4908-bcf7-cbe9b00fbe53';

const flowId = 'secret-keeper';
createWorkflows({ db, variants }).create({
  id: flowId,
  name: '记住暗号',
  description: '记住用户给的暗号并只回答"记住了"',
  definition: { id: flowId, name: '记住暗号', stages: [{ id: 'remember' }] },
});
const analysed = variants.list().find((v) => v.workflowId === flowId);
if (analysed === undefined) throw new Error(`workflow ${flowId} 没有建出初稿`);
// 小阶段 remember 的 skill 写成一份有表格、任务列表、代码与 mermaid 的 Markdown，修改建议改其中相隔较远的三处
const rememberSkill = fs.readFileSync(
  path.join(config.repoRoot, 'server/scripts/fixtures/remember-skill.md'),
  'utf8',
);
variants.writeFile(analysed.id, 'skills/remember/SKILL.md', rememberSkill);
await variants.build(analysed.id);
// session 放在初稿的配置目录中（分析的范围按 session 所在的配置，Contracts 27），作为它在 Live 中的 session 绑定
const sessionFile = path.join(
  variants.layout(analysed.id).claudeDir,
  'projects',
  '-e2e-secret-keeper',
  `${SESSION}.jsonl`,
);
fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
fs.copyFileSync(
  path.join(config.repoRoot, 'server/test/fixtures/live', `${SESSION}.jsonl`),
  sessionFile,
);
ingestFile(db, sessionFile);
bindLiveSession(db, config.dataDir, SESSION, analysed.id);

const baseline = await ensureAnalysisBaseline(db, variants);
const method = variants.derive(baseline.id, { name: '只看失败' });
variants.writeFile(
  method.id,
  'skills/failures/SKILL.md',
  `${variants.readFile(method.id, 'skills/failures/SKILL.md')}\n只报告最终没有恢复的失败。\n`,
);
await variants.build(method.id);

const stages = loadWorkflow(db, 'session-analysis').stages.map((s) => s.id);
const aspects = stages.slice(0, -1);
const id = newAnalysisId();
const started = Date.parse('2026-10-13T08:00:00Z');
db.insert(analyses)
  .values({
    id,
    engine: 'claude',
    model: 'claude-opus-5-5',
    variantId: analysed.id,
    analysisVariantId: baseline.id,
    sessionIds: [SESSION],
    status: 'succeeded',
    steps: stages.map((key, i) => ({
      key,
      status: 'succeeded' as const,
      startedAt: started,
      endedAt: started + 12_000 + i * 1_000,
      tokens: { input: 20, output: 900, cacheRead: 40_000, cacheWrite: 9_000, reasoning: 0 },
      costUsd: 0.1,
      events: 30,
      error: null,
    })),
    costUsd: 0.1 * stages.length,
    report: {
      summary:
        '这个 session 只有一轮：用户让 agent 记住暗号并只回答"记住了"，agent 照做了。入口 skill 没有被调用，阶段 remember 没有进入。',
      goal: '记住暗号"青蛙-47"，并且只回答"记住了"',
      outcome: 'achieved',
      topIssues: [
        {
          title: '没有进入阶段 remember',
          findingIds: ['process-adherence-1'],
          impact: '阶段划分为空，看不出 skill 是否起作用',
        },
      ],
      workflowChanges: [
        {
          findingIds: ['process-adherence-1'],
          rationale: '一轮对话不需要单独的阶段',
          change: '去掉小阶段 remember，只保留入口',
        },
      ],
    },
    endedAt: new Date(started + 30_000),
  })
  .run();
for (const aspect of aspects) {
  db.insert(analysisFindings)
    .values({
      analysisId: id,
      findingId: `${aspect}-1`,
      aspect,
      title: `${aspect} 的一条发现`,
      stage: aspect === 'process-adherence' ? 'remember' : null,
      skill: aspect === 'process-adherence' ? flowId : null,
      severity: aspect === 'process-adherence' ? 'high' : 'low',
      detail: '测试数据。',
      evidence: [{ sessionId: SESSION, seq: 1, quote: '记住了' }],
    })
    .run();
}
// 成功的分析在分析目录中留下被分析 variant 的 skill 副本、引擎的输出与修改建议的结果。
// patches.json 是对 remember/SKILL.md 的一个真实的 unified diff，与真实分析相同地经 validatePatches 校验并拆成逐处改动
const dirs = analysisLayout(config.dataDir, id);
fs.mkdirSync(dirs.output, { recursive: true });
fs.cpSync(variants.layout(analysed.id).skills, path.join(dirs.input, 'skills'), {
  recursive: true,
});
const proposedSkill = rememberSkill
  .replace(
    'answer with the single word they asked for.',
    'answer with the single word they asked for, in the language of the request.',
  )
  .replace(
    '- [ ] Reply with exactly "记住了"\n',
    '- [ ] Reply with exactly "记住了"\n- [ ] Call the `remember` skill before replying\n',
  )
  .replace(
    '| A later question about it | The passphrase, word for word |\n',
    '| A later question about it | The passphrase, word for word |\n| Anything else | Nothing about the passphrase |\n',
  )
  .replace('Never translate it.\n', 'Never translate it, and never shorten it.\n');
const patchesFile = path.join(dirs.output, 'patches.json');
fs.writeFileSync(
  patchesFile,
  `${JSON.stringify(
    [
      {
        file: 'remember/SKILL.md',
        findingIds: ['process-adherence-1', 'user-interaction-1'],
        rationale: '写明进入阶段前要调用 remember，并补上回复的语言与其他输入的规定。',
        patch: createTwoFilesPatch(
          'a/remember/SKILL.md',
          'b/remember/SKILL.md',
          rememberSkill,
          proposedSkill,
        ),
      },
    ],
    null,
    1,
  )}\n`,
);
const proposal = await validatePatches(
  patchesFile,
  path.join(dirs.input, 'skills'),
  dirs.check,
  new Set(aspects.map((a) => `${a}-1`)),
);
fs.writeFileSync(dirs.proposals, `${JSON.stringify(proposal.files)}\n`);
for (const p of proposal.patches) {
  db.insert(analysisPatches)
    .values({
      analysisId: id,
      file: p.file,
      findingIds: p.findingIds,
      rationale: p.rationale,
      patch: p.patch,
    })
    .run();
}
console.log(
  JSON.stringify({ analysis: id, analysed: analysed.id, baseline: baseline.id, method: method.id }),
);
db.$client.close();
