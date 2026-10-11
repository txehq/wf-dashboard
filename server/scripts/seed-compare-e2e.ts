import fs from 'node:fs';
import path from 'node:path';
import { asc, eq } from 'drizzle-orm';
import { parse } from 'yaml';
import { z } from 'zod';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import {
  artifacts,
  batches,
  batchTasks,
  batchVariants,
  gradeItems,
  grades,
  requests,
  runMessages,
  runs,
  sessions,
  type ToolCall,
  variants as variantsTable,
} from '../src/db/schema.js';
import type { IcDetail } from '../src/grading/schema.js';
import { initialParseState } from '../src/ingest/ingest.js';
import { costUsd } from '../src/llm/pricing.js';
import { scanCrossRunRefs } from '../src/runs/cross-run-refs.js';
import { updateStages } from '../src/stages/report.js';
import { LFG_STAGES } from '../src/stages/workflow.js';
import { loadIcTask, loadLfgTask, syncTasks, withHiddenTests } from '../src/tasks/loader.js';
import type { RubricArtifact } from '../src/tasks/schema.js';
import { createVariants } from '../src/variants/index.js';

// 用法：WFD_DATA_DIR=<e2e 数据目录> tsx scripts/seed-compare-e2e.ts
// 清空该数据目录，写入 Compare 页面 e2e 用的数据：基线与一个修改过的 variant（真实导出与派生），
// lfg-calculator 与 ic-money-format 各 3 次已评分的 run，另有一次有人工干预的基线 lfg run，
// 一次参考了其他 run 仓库的 ic run。
// run、session、请求、阶段、模拟用户消息、产物快照与评分的形状与运行模块和评分模块写入的相同。

if (config.dataDir === path.join(config.repoRoot, 'data')) {
  throw new Error('WFD_DATA_DIR 未设置：种子脚本会清空数据目录，不能用于 data/');
}

const fixtures = path.join(config.repoRoot, 'server/scripts/fixtures/compare');
const vault = config.vaultDir;
const agentModel = 'claude-opus-5-5';
const judgeModel = 'claude-opus-5-5';
const simulatedUserModel = 'claude-sonnet-4-6';

fs.rmSync(config.dataDir, { recursive: true, force: true });
const db = openDatabase(config.dbPath, config.migrationsDir);
syncTasks(db, config.tasksDir);
const lfgTask = loadLfgTask(db, 'lfg-calculator');
const icTask = withHiddenTests(loadIcTask(db, 'ic-money-format'));

// 确定的伪随机数，每次生成相同的数据
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const between = (r: () => number, lo: number, hi: number) => Math.round(lo + r() * (hi - lo));

// ---- variants：从 txe-workflow 导出基线，派生后修改 interview 与 research 两个 skill ----

const variantsModule = createVariants({
  db,
  dataDir: config.dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});
const baseline = await variantsModule.createBaseline({
  name: '基线 v2.3.0',
  model: 'opus',
  effort: 'high',
});
const modified = variantsModule.derive(baseline.id, { name: 'interview 追问边界' });

function editSkill(file: string, anchor: string, insert: string) {
  const content = variantsModule.readFile(modified.id, file);
  if (!content.includes(anchor)) throw new Error(`${file} 中没有锚点：${anchor}`);
  variantsModule.writeFile(modified.id, file, content.replace(anchor, `${anchor}${insert}`));
}
editSkill(
  'skills/interview/SKILL.md',
  'Skip any question the request, the authoritative spec, the repository, its documentation,\ntests, runtime evidence, conventions, or a prior confirmed decision already answers.\n',
  `
## Boundaries are asked, not assumed

Before the play-back, ask the user explicitly for three boundaries the brief must state:

- **Where it runs** — the devices, operating systems and browsers, with versions.
- **What it must never do** — network access, data collection, external writes.
- **What is out of scope** — list every exclusion the user names, one per line.

Each answer goes into the brief verbatim; an unanswered boundary is an open question.
`,
);
editSkill(
  'skills/research/SKILL.md',
  '## 4. Every recommendation carries its reference\n',
  `
Every constraint the brief states about the runtime environment (operating system, browser
version, offline use) is checked against the chosen technology with a cited source.
`,
);
// 第三个 variant 只试跑了一次 lfg：差值不可信、ic 格子没有 run
const trial = variantsModule.derive(modified.id, { name: 'plan 先问细节（试跑）' });
const planSkill = variantsModule.readFile(trial.id, 'skills/plan/SKILL.md');
const planAnchor = '## 2. Ask back about implementation details\n';
if (!planSkill.includes(planAnchor)) throw new Error(`plan SKILL.md 中没有锚点：${planAnchor}`);
variantsModule.writeFile(
  trial.id,
  'skills/plan/SKILL.md',
  planSkill.replace(
    planAnchor,
    `${planAnchor}\nAsk every implementation-detail question before the Plan agent review, never after.\n`,
  ),
);
// 被运行过的 variant 已构建并冻结
for (const v of [baseline, modified, trial]) {
  const row = variantsModule.get(v.id);
  db.update(variantsTable)
    .set({
      buildStatus: 'built',
      builtHash: row.skillsHash,
      builtAt: new Date('2026-10-09T07:30:00Z'),
      status: 'frozen',
      frozenAt: new Date('2026-10-09T07:40:00Z'),
    })
    .where(eq(variantsTable.id, v.id))
    .run();
}

// ---- 评分理由 ----

const Score = z.tuple([z.number().int(), z.string()]);
const GradeFixture = z.object({
  baseline: z.record(z.string(), Score),
  modified: z.record(z.string(), Score),
  variations: z.array(
    z.object({
      variant: z.enum(['baseline', 'modified']),
      run: z.number().int(),
      item: z.string(),
      score: z.number().int(),
      reasoning: z.string(),
    }),
  ),
});
const gradeFixture = GradeFixture.parse(
  parse(fs.readFileSync(path.join(fixtures, 'grades.yaml'), 'utf8')),
);

type VariantKey = 'baseline' | 'modified';
const variantIds: Record<VariantKey, string> = { baseline: baseline.id, modified: modified.id };

function doc(variant: VariantKey, name: string) {
  return fs.readFileSync(path.join(fixtures, variant, `${name}.md`), 'utf8');
}

// ---- session：请求、阶段区间、阶段判定 ----

interface StagePlan {
  stage: string;
  requests: number;
  tools: string[];
  // 该阶段内带子代理的 Agent 调用次数
  subagents: number;
}

interface SessionPlan {
  sessionId: string;
  workflow: 'lfg' | 'ic';
  stages: StagePlan[];
  startedAt: number;
  r: () => number;
}

function toolCall(name: string, r: () => number, subagentId: string | null = null): ToolCall {
  const resultChars = between(r, 40, 6000);
  return {
    id: `toolu_${Math.floor(r() * 1e16).toString(36)}`,
    name,
    input: name === 'Bash' ? { command: 'git status --short' } : {},
    result: `（${name} 的结果，${String(resultChars)} 字符）`,
    resultChars,
    isError: r() < 0.03,
    spillPath: null,
    subagentId,
  };
}

function usage(r: () => number, contextK: number) {
  return {
    inputTokens: between(r, 3, 12),
    outputTokens: between(r, 180, 1600),
    cacheReadTokens: contextK * 1000 + between(r, 0, 900),
    cacheCreationTokens: between(r, 600, 4200),
  };
}

function requestCost(u: ReturnType<typeof usage>, model: string) {
  return costUsd(
    {
      inputTokens: u.inputTokens,
      outputTokens: u.outputTokens,
      cacheReadTokens: u.cacheReadTokens,
      cacheWrite5mTokens: u.cacheCreationTokens,
      cacheWrite1hTokens: 0,
    },
    model,
  );
}

function seedSession(plan: SessionPlan): number {
  const { sessionId, r } = plan;
  let at = plan.startedAt;
  let seq = 0;
  let context = 18;
  let subagentCount = 0;
  for (const stage of plan.stages) {
    let subagentsLeft = stage.subagents;
    for (let i = 0; i < stage.requests; i++) {
      const name = stage.tools[i % stage.tools.length] ?? 'Read';
      const calls: ToolCall[] = [];
      let agentId: string | null = null;
      // 每个阶段的第一条请求调用该阶段的 Skill：阶段划分由 stages 模块按 Skill 调用切块
      if (i === 0) calls.push({ ...toolCall('Skill', r), input: { skill: stage.stage } });
      else if (subagentsLeft > 0 && i % 3 === 1) {
        agentId = `a${(subagentCount++).toString(16).padStart(16, '0')}`;
        calls.push(toolCall('Agent', r, agentId));
        subagentsLeft--;
      } else if (r() < 0.8) calls.push(toolCall(name, r));
      if (r() < 0.25) calls.push(toolCall('Read', r));
      const u = usage(r, context);
      const triggerAt = at;
      at += between(r, 2500, 21000);
      db.insert(requests)
        .values({
          sessionId,
          messageId: `msg_${sessionId}_${String(seq)}`,
          seq,
          agentId: null,
          timestamp: new Date(at),
          triggerAt: new Date(triggerAt),
          model: agentModel,
          thinking: null,
          text: calls.length === 0 ? `${stage.stage} 阶段的进展说明。` : null,
          toolCalls: calls,
          ...u,
          costUsd: requestCost(u, agentModel),
          durationMs: at - triggerAt,
          attributionSkill: stage.stage,
        })
        .run();
      if (agentId !== null) {
        // 子代理的请求按 statsOf 计入父调用所在阶段
        const subRequests = between(r, 4, 9);
        let subAt = at;
        for (let k = 0; k < subRequests; k++) {
          const su = usage(r, 12 + k * 3);
          const subTrigger = subAt;
          subAt += between(r, 2000, 12000);
          db.insert(requests)
            .values({
              sessionId,
              messageId: `msg_${sessionId}_${agentId}_${String(k)}`,
              seq: k,
              agentId,
              timestamp: new Date(subAt),
              triggerAt: new Date(subTrigger),
              model: agentModel,
              toolCalls: [toolCall(k % 2 === 0 ? 'Grep' : 'Read', r)],
              ...su,
              costUsd: requestCost(su, agentModel),
              durationMs: subAt - subTrigger,
            })
            .run();
        }
        at = subAt;
      }
      context = Math.min(context + between(r, 1, 4), 160);
      seq++;
    }
  }
  // run 行已是终态，最后一个阶段为 done
  updateStages(db, sessionId);
  return at;
}

// ---- 模拟用户对话 ----

const lfgDialogue: Record<VariantKey, string[]> = {
  baseline: [
    '想先确认一下：这个计算器主要是谁在用、在什么场合用？',
    '是我班上的学生，初一到初三，在学校机房上课用，我也会在投影上演示。',
    '需要支持哪些运算？',
    '加减乘除、括号、负数、小数、百分号、乘方和开平方。0.1+0.2 一定要显示 0.3，学生被那个长尾巴弄糊涂过。',
    'Brief 已写好，接下来做调研。',
    '好的。',
    '工单已建好，是否派发 /ic？',
    '不派发，到此结束。',
  ],
  modified: [
    '这个计算器主要是谁在用、在哪些设备上用？电脑的系统和浏览器是什么版本？',
    '初一到初三的学生，在学校机房和家里用；机房是 Windows 7，学校装的 Chrome 109。我会在投影上演示。',
    '机房断网时也要能用吗？有没有什么是它绝对不能做的？',
    '必须完全离线，机房经常断网。也不能收集学生的任何数据。',
    '有哪些是这次明确不做的？',
    '三角函数、对数、画函数图像、分数结果、单位换算、账号登录、手机 App、多语言都不要。',
    '除不尽的时候显示几位？',
    '四舍五入到 10 位小数，末尾的 0 去掉，比如 1/3 显示 0.3333333333。',
    '工单已建好，是否派发 /ic？',
    '不派发，到此结束。',
  ],
};

const icDialogue = [
  '工单已认领，需求清单已发布。readiness 检查通过，开始实现。',
  '好的，按工单来。',
  'PR 已打开并请求了 review，正在处理 review 意见。',
  '继续。',
  'PR 已进入 ready-for-review。',
  '好的，结束。',
];

function seedMessages(runId: string, lines: string[], r: () => number, intervened: boolean) {
  lines.forEach((content, seq) => {
    const agent = seq % 2 === 0;
    // 接管后的回答来自人，没有模拟用户花费
    const human = intervened && !agent && seq >= 3;
    const inputTokens = between(r, 2500, 7000);
    const outputTokens = between(r, 40, 220);
    db.insert(runMessages)
      .values({
        runId,
        seq,
        role: agent ? 'agent' : human ? 'human' : 'simulated_user',
        content,
        costUsd:
          agent || human
            ? 0
            : costUsd(
                {
                  inputTokens,
                  outputTokens,
                  cacheReadTokens: 0,
                  cacheWrite5mTokens: 0,
                  cacheWrite1hTokens: 0,
                },
                simulatedUserModel,
              ),
      })
      .run();
  });
}

// ---- run ----

const batchId = 'b-20261009-seed01';
db.insert(batches).values({ id: batchId, repeats: 3 }).run();
for (const id of Object.values(variantIds)) {
  db.insert(batchVariants).values({ batchId, variantId: id }).run();
}
for (const id of [lfgTask.id, icTask.id]) {
  db.insert(batchTasks).values({ batchId, taskId: id }).run();
}
const takeoverBatch = 'b-20261009-seed02';
db.insert(batches).values({ id: takeoverBatch, repeats: 1 }).run();
db.insert(batchVariants).values({ batchId: takeoverBatch, variantId: baseline.id }).run();
db.insert(batchTasks).values({ batchId: takeoverBatch, taskId: lfgTask.id }).run();
const trialBatch = 'b-20261009-seed03';
db.insert(batches).values({ id: trialBatch, repeats: 1 }).run();
db.insert(batchVariants).values({ batchId: trialBatch, variantId: trial.id }).run();
db.insert(batchTasks).values({ batchId: trialBatch, taskId: lfgTask.id }).run();

let clock = new Date('2026-10-09T08:00:00Z').getTime();
let ticketNumber = 3301;

function insertRunRow(args: {
  id: string;
  batchId: string;
  taskId: string;
  variantId: string;
  repeatIndex: number;
  humanIntervened: boolean;
  github: boolean;
}) {
  const sessionId = `00000000-0000-4000-8000-${args.id.slice(-6).padStart(12, '0')}`;
  const startedAt = clock;
  clock += 47 * 60_000;
  db.insert(runs)
    .values({
      id: args.id,
      batchId: args.batchId,
      taskId: args.taskId,
      variantId: args.variantId,
      repeatIndex: args.repeatIndex,
      status: 'succeeded',
      humanIntervened: args.humanIntervened,
      sessionId,
      workspacePath: path.join(config.runsDir, args.id, 'workspace'),
      linearIssueIdentifier: args.github ? `TXE-${String(ticketNumber++)}` : null,
      githubRepo: `txehq/wfe-${args.id}`,
      prUrl: args.github ? `https://github.com/txehq/wfe-${args.id}/pull/1` : null,
      createdAt: new Date(startedAt - 60_000),
      startedAt: new Date(startedAt),
    })
    .run();
  db.insert(sessions)
    .values({
      id: sessionId,
      runId: args.id,
      filePath: path.join(
        config.variantsDir,
        args.variantId,
        `home/claude/projects/${args.id}/${sessionId}.jsonl`,
      ),
      cwd: path.join(config.runsDir, args.id, 'workspace'),
      title: args.taskId === lfgTask.id ? '/lfg 做一个计算器' : '/ic TXE-3301',
      startedAt: new Date(startedAt),
      endedAt: new Date(startedAt),
      hasLfg: args.taskId === lfgTask.id,
      hasIc: args.taskId === icTask.id,
      parseState: initialParseState(),
    })
    .run();
  return { sessionId, startedAt };
}

function finishRun(runId: string, sessionId: string, endedAt: number) {
  db.update(runs)
    .set({ endedAt: new Date(endedAt) })
    .where(eq(runs.id, runId))
    .run();
  db.update(sessions)
    .set({ endedAt: new Date(endedAt) })
    .where(eq(sessions.id, sessionId))
    .run();
}

const lfgProfiles: Record<VariantKey, Record<string, [number, number]>> = {
  // 每个阶段的请求数与子代理数
  baseline: { interview: [9, 0], research: [24, 3], plan: [11, 1], ticketing: [13, 0] },
  modified: { interview: [17, 0], research: [20, 2], plan: [10, 1], ticketing: [15, 0] },
};
const lfgTools: Record<string, string[]> = {
  interview: ['Read', 'Glob', 'Grep', 'Bash', 'Write'],
  research: ['WebSearch', 'WebFetch', 'Read', 'Bash', 'Write', 'Grep'],
  plan: ['Read', 'Edit', 'Bash'],
  ticketing: ['mcp__capso-linear__list_issues', 'mcp__capso-linear__save_issue', 'Bash', 'Write'],
};

function seedLfgRun(
  variant: VariantKey,
  index: number,
  id: string,
  intervened: boolean,
  variantId = variantIds[variant],
) {
  const r = rng(id.split('').reduce((h, c) => h * 31 + c.charCodeAt(0), 7));
  const { sessionId, startedAt } = insertRunRow({
    id,
    batchId: intervened ? takeoverBatch : variantId === trial.id ? trialBatch : batchId,
    taskId: lfgTask.id,
    variantId,
    repeatIndex: intervened ? 0 : index,
    humanIntervened: intervened,
    github: false,
  });
  const profile = lfgProfiles[variant];
  const endedAt = seedSession({
    sessionId,
    workflow: 'lfg',
    stages: LFG_STAGES.map((stage) => {
      const [n, subagents] = profile[stage] ?? [0, 0];
      return {
        stage,
        requests: Math.max(3, Math.round(n * (0.85 + r() * 0.3))),
        tools: lfgTools[stage] ?? [],
        subagents,
      };
    }),
    startedAt,
    r,
  });
  finishRun(id, sessionId, endedAt);
  seedMessages(id, lfgDialogue[variant], r, intervened);

  const feature = path.join(vault, 'Project Magi Eval/Features', id);
  const research = doc(variant, 'research');
  const snapshots: Record<RubricArtifact, { location: string; snapshot: string }> = {
    brief: { location: path.join(feature, 'Brief.md'), snapshot: doc(variant, 'brief') },
    research: { location: path.join(feature, 'Research.md'), snapshot: research },
    plan: {
      location: path.join(feature, 'Research.md'),
      snapshot: `${research}\n${doc(variant, 'plan')}`,
    },
    tickets: { location: path.join(feature, 'Tickets.md'), snapshot: doc(variant, 'tickets') },
  };
  const base = gradeFixture[variant];
  for (const group of lfgTask.rubric) {
    const { location, snapshot } = snapshots[group.artifact];
    const artifact = db
      .insert(artifacts)
      .values({ runId: id, kind: group.artifact, location, snapshot })
      .returning({ id: artifacts.id })
      .get();
    const inputTokens = Math.round(snapshot.length * 0.9) + between(r, 1800, 2600);
    const outputTokens = between(r, 520, 1400);
    const grade = db
      .insert(grades)
      .values({
        runId: id,
        kind: 'rubric',
        artifact: group.artifact,
        artifactId: artifact.id,
        judgeModel,
        inputTokens,
        outputTokens,
        costUsd: costUsd(
          {
            inputTokens,
            outputTokens,
            cacheReadTokens: 0,
            cacheWrite5mTokens: 0,
            cacheWrite1hTokens: 0,
          },
          judgeModel,
        ),
      })
      .returning({ id: grades.id })
      .get();
    for (const item of group.items) {
      const fixed = base[item.id];
      if (fixed === undefined) throw new Error(`grades.yaml 的 ${variant} 缺少 ${item.id}`);
      const variation = gradeFixture.variations.find(
        (v) => v.variant === variant && v.run === index && v.item === item.id,
      );
      const [score, reasoning] = variation ? [variation.score, variation.reasoning] : fixed;
      if (score > item.maxScore) throw new Error(`${item.id} 的分数超过满分`);
      db.insert(gradeItems)
        .values({
          gradeId: grade.id,
          itemId: item.id,
          criterion: item.criterion,
          score,
          maxScore: item.maxScore,
          reasoning,
        })
        .run();
    }
  }
}

const icTests = Object.entries(icTask.hiddenTests.manifest).flatMap(([file, names]) =>
  names.map((name) => ({ file, name })),
);
// 越靠后越难：大金额与非法输入最常失败
const icDifficulty = [...icTests].reverse();
const icResults: Record<VariantKey, { passed: number; reached: boolean }[]> = {
  baseline: [
    { passed: 14, reached: true },
    { passed: 11, reached: false },
    { passed: 16, reached: true },
    // agent 的 package-lock.json 让 npm ci 失败的那次 run（Contracts 7.9）：标为无效，不参与对比，只用来看运行详情
    { passed: 0, reached: false },
  ],
  modified: [
    { passed: 17, reached: true },
    { passed: 19, reached: true },
    { passed: 18, reached: false },
    // 参考了基线 ic run 仓库的那次 run
    { passed: 19, reached: true },
  ],
};
const icProfiles: Record<VariantKey, [string, number, number][]> = {
  baseline: [
    ['claim', 6, 0],
    ['readiness', 4, 0],
    ['implement', 26, 2],
    ['acceptance', 7, 0],
    ['open-pr', 5, 0],
    ['fix-pr', 15, 1],
    ['ready-for-review', 3, 0],
  ],
  modified: [
    ['claim', 6, 0],
    ['readiness', 4, 0],
    ['implement', 22, 1],
    ['acceptance', 9, 0],
    ['open-pr', 5, 0],
    ['fix-pr', 10, 1],
    ['ready-for-review', 3, 0],
  ],
};
const icTools: Record<string, string[]> = {
  claim: ['mcp__capso-linear__get_issue', 'mcp__capso-linear__save_comment', 'Read'],
  readiness: ['Bash'],
  implement: ['Read', 'Edit', 'Bash', 'Write', 'Grep'],
  acceptance: ['Bash', 'Read'],
  'open-pr': ['Bash', 'mcp__capso-linear__save_comment'],
  'fix-pr': ['Bash', 'Read', 'Edit'],
  'ready-for-review': ['Bash', 'mcp__capso-linear__save_issue'],
};

function seedIcRun(variant: VariantKey, index: number, id: string) {
  const r = rng(id.split('').reduce((h, c) => h * 31 + c.charCodeAt(0), 11));
  const { sessionId, startedAt } = insertRunRow({
    id,
    batchId,
    taskId: icTask.id,
    variantId: variantIds[variant],
    repeatIndex: index,
    humanIntervened: false,
    github: true,
  });
  const result = icResults[variant][index];
  if (result === undefined) throw new Error(`没有 ${variant} 第 ${String(index)} 次 ic 的结果`);
  const profile = icProfiles[variant].filter(
    ([stage]) => result.reached || stage !== 'ready-for-review',
  );
  const endedAt = seedSession({
    sessionId,
    workflow: 'ic',
    stages: profile.map(([stage, n, subagents]) => ({
      stage,
      requests: Math.max(2, Math.round(n * (0.85 + r() * 0.3))),
      tools: icTools[stage] ?? [],
      subagents,
    })),
    startedAt,
    r,
  });
  finishRun(id, sessionId, endedAt);
  seedMessages(id, result.reached ? icDialogue : icDialogue.slice(0, 4), r, false);

  const repoUrl = `https://github.com/txehq/wfe-${id}`;
  const prUrl = `${repoUrl}/pull/1`;
  db.insert(artifacts).values({ runId: id, kind: 'repo', location: repoUrl, snapshot: null }).run();
  db.insert(artifacts).values({ runId: id, kind: 'pr', location: prUrl, snapshot: null }).run();
  const failing = new Set(
    icDifficulty.slice(0, icTests.length - result.passed).map((t) => `${t.file}\0${t.name}`),
  );
  const head = Array.from({ length: 40 }, () => Math.floor(r() * 16).toString(16)).join('');
  const detail: IcDetail = {
    pr: { number: 1, url: prUrl, branch: 'fix/money-format-decimals', head },
    outcomes: icTests.map((t) => ({
      ...t,
      outcome: failing.has(`${t.file}\0${t.name}`) ? 'failed' : 'passed',
    })),
    fileErrors: [],
    endpoint: result.reached
      ? { reached: true, ciGreen: true, isDraft: false, head, missingRequired: [] }
      : { reached: false, ciGreen: false, isDraft: true, head, missingRequired: ['test'] },
    error: null,
  };
  db.insert(grades)
    .values({
      runId: id,
      kind: 'ic',
      testsPassed: result.passed,
      testsDeclared: icTests.length,
      reachedEnd: result.reached,
      icDetail: detail,
    })
    .run();
}

const variantCodes: Record<VariantKey, string> = { baseline: 'ba', modified: 'mo' };
for (let index = 0; index < 3; index++) {
  for (const variant of ['baseline', 'modified'] as const) {
    seedLfgRun(variant, index, `r-20261009-${variantCodes[variant]}lf0${String(index)}`, false);
    seedIcRun(variant, index, `r-20261009-${variantCodes[variant]}ic0${String(index)}`);
  }
}
seedLfgRun('baseline', 3, 'r-20261009-balf03', true);
// 基线第 5 次 lfg run 被用户取消，按已写出的产物评分（Contracts 7.5），默认不参与对比
const cancelledRun = 'r-20261009-balf04';
seedLfgRun('baseline', 4, cancelledRun, false);
db.update(runs).set({ status: 'cancelled' }).where(eq(runs.id, cancelledRun)).run();
// 试跑的 variant 产物与 "interview 追问边界" 相同，评分取其第 2 次 run
seedLfgRun('modified', 1, 'r-20261009-trlf00', false, trial.id);

// 修改后的 variant 第 4 次 ic run 在 implement 中读取了基线第 1 次 ic run 的仓库，引用由 runs 模块的扫描写入
const crossRefRun = 'r-20261009-moic03';
seedIcRun('modified', 3, crossRefRun);
const crossRefSession = db.select().from(runs).where(eq(runs.id, crossRefRun)).get()?.sessionId;
if (crossRefSession === undefined) throw new Error(`没有 run ${crossRefRun}`);
const readRequest = db
  .select()
  .from(requests)
  .where(eq(requests.sessionId, crossRefSession))
  .orderBy(asc(requests.seq))
  .all()
  .filter((q) => q.agentId === null)[14];
if (readRequest === undefined) throw new Error(`run ${crossRefRun} 的请求不足 15 条`);
db.update(requests)
  .set({
    toolCalls: [
      ...readRequest.toolCalls,
      {
        id: 'toolu_crossref0000001',
        name: 'Bash',
        input: {
          command:
            'gh api repos/txehq/wfe-r-20261009-baic00/contents/src/format.js --jq .content | base64 -d',
        },
        result: '（format.js 的内容）',
        resultChars: 2400,
        isError: false,
        spillPath: null,
        subagentId: null,
      },
    ],
  })
  .where(eq(requests.id, readRequest.id))
  .run();
db.update(runs)
  .set({ crossRunRefs: scanCrossRunRefs(db, crossRefRun) })
  .where(eq(runs.id, crossRefRun))
  .run();

// 隐藏测试因 agent 的代码没能运行：error 为 npm ci 的原文，测试记 0，评分 done
const npmCiRun = 'r-20261009-baic03';
seedIcRun('baseline', 3, npmCiRun);
const npmCiGrade = db.select().from(grades).where(eq(grades.runId, npmCiRun)).get();
if (npmCiGrade?.icDetail == null) throw new Error(`run ${npmCiRun} 没有 ic 评分`);
db.update(grades)
  .set({
    icDetail: {
      ...npmCiGrade.icDetail,
      outcomes: npmCiGrade.icDetail.outcomes.map((o) => ({ ...o, outcome: 'not-run' as const })),
      error:
        'npm ci 退出码 1：npm error code EINTEGRITY\nnpm error sha512-AAAA… integrity checksum failed when using sha512',
    },
  })
  .where(eq(grades.id, npmCiGrade.id))
  .run();
db.update(runs)
  .set({
    gradingStatus: 'done',
    invalidReason: '只用于运行详情的 e2e：隐藏测试的错误显示',
  })
  .where(eq(runs.id, npmCiRun))
  .run();

// 读取了来源工单与来源 PR 的 run（Contracts 第 13 节）：compare 默认排除，includeSourceRef 放回。
// 记录的形状与 scanSourceRefs 在 W28 的真实 run r-20261011-5vqkvn 上得到的相同
const sourceRefRun = 'r-20261009-baic05';
seedIcRun('baseline', 5, sourceRefRun);
db.update(runs)
  .set({
    sourceRefs: [
      {
        kind: 'ticket',
        requestSeq: 4,
        toolCallId: 'toolu_sourceref000001',
        excerpt: 'id: TXE-3635',
      },
      {
        kind: 'pr',
        requestSeq: 5,
        toolCallId: 'toolu_sourceref000002',
        excerpt: 'command: gh pr view 638 --repo txehq/tokun-cn --json state,mergedAt',
      },
    ],
  })
  .where(eq(runs.id, sourceRefRun))
  .run();

console.log(
  JSON.stringify({
    dataDir: config.dataDir,
    baseline: baseline.id,
    modified: modified.id,
    trial: trial.id,
  }),
);
db.$client.close();
