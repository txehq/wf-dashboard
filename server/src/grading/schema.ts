import { z } from 'zod';

// 本文件只依赖 zod，web 也直接引用这里的 schema

export const Outcome = z.object({
  file: z.string(),
  name: z.string(),
  outcome: z.enum(['passed', 'failed', 'errored', 'skipped', 'not-run']),
});

export const FileError = z.object({ file: z.string(), message: z.string() });

export const IcEndpoint = z.object({
  reached: z.boolean(),
  ciGreen: z.boolean(),
  isDraft: z.boolean(),
  head: z.string(),
  missingRequired: z.array(z.string()),
});

// ic 评分的明细；没有 PR 时 pr 与 endpoint 为空，清单中的测试全部为 not-run；
// agent 的代码让 checkout 内的步骤失败或超时时写在 error 中（测试全部为 not-run，记 0 分，评分照常完成，Contracts 7.9），
// 没有该字段的明细读出为 null
export const IcDetail = z.object({
  pr: z
    .object({ number: z.number(), url: z.string(), branch: z.string(), head: z.string() })
    .nullable(),
  outcomes: z.array(Outcome),
  fileErrors: z.array(FileError),
  endpoint: IcEndpoint.nullable(),
  error: z.string().nullable().default(null),
});
export type IcDetail = z.infer<typeof IcDetail>;

export const GradeItem = z.object({
  itemId: z.string(),
  criterion: z.string(),
  score: z.number(),
  maxScore: z.number(),
  reasoning: z.string(),
});
export type GradeItem = z.infer<typeof GradeItem>;

// 没有隐藏测试的 ic task 的评分明细（Contracts 第 13 节）：没有 PR 时 pr、endpoint 为空，每条验收标准记 0 分，不调用 judge
export const IcCriteriaDetail = z.object({
  pr: z
    .object({ number: z.number(), url: z.string(), branch: z.string(), head: z.string() })
    .nullable(),
  endpoint: IcEndpoint.nullable(),
  // 交给 judge 的 CI 结果：PR head 上各 check 的名字与结论
  checks: z.array(z.object({ name: z.string(), bucket: z.string(), state: z.string() })),
  diffChars: z.number(),
});
export type IcCriteriaDetail = z.infer<typeof IcCriteriaDetail>;

export const IcCriteriaGrade = z.object({
  items: z.array(GradeItem),
  score: z.number(),
  maxScore: z.number(),
  judgeModel: z.string().nullable(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
  detail: IcCriteriaDetail,
});
export type IcCriteriaGrade = z.infer<typeof IcCriteriaGrade>;

export const ArtifactGrade = z.object({
  // rubric 分组 id（评测类型 rubric 积木的产物 id）
  artifact: z.string(),
  // 评分时产物是否存在；不存在时每条记 0 分，没有 judge 调用
  present: z.boolean(),
  artifactId: z.number().nullable(),
  judgeModel: z.string().nullable(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  costUsd: z.number(),
  score: z.number(),
  maxScore: z.number(),
  items: z.array(GradeItem),
});
export type ArtifactGrade = z.infer<typeof ArtifactGrade>;

// 按评分积木分别记录（Contracts 16.2）；为空表示评测类型没有这项评分
export const RunGrades = z.object({
  runId: z.string(),
  // judge 调用的花费合计，计入 run 成本的评分一项
  costUsd: z.number(),
  rubric: z
    .object({ artifacts: z.array(ArtifactGrade), score: z.number(), maxScore: z.number() })
    .nullable(),
  hiddenTests: z
    .object({
      testsPassed: z.number(),
      testsDeclared: z.number(),
      detail: IcDetail,
    })
    .nullable(),
  // 没有隐藏测试时：验收标准逐条的得分与理由
  criteria: IcCriteriaGrade.nullable(),
  // pr-endpoint：PR 不是 draft 且 requiredChecks 通过；没有 PR 时 detail 为空
  endpoint: z.object({ reached: z.boolean(), detail: IcEndpoint.nullable() }).nullable(),
});
export type RunGrades = z.infer<typeof RunGrades>;

// 一组 run 上某个数值的分布：离散程度为样本标准差（n − 1），不足两个 run 时为空；values 供页面画分布
export const Distribution = z.object({
  n: z.number(),
  mean: z.number().nullable(),
  stdDev: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
  values: z.array(z.object({ runId: z.string(), value: z.number() })),
});
export type Distribution = z.infer<typeof Distribution>;

export const CostBreakdown = z.object({
  agent: z.number(),
  simulatedUser: z.number(),
  grading: z.number(),
  total: z.number(),
});
export type CostBreakdown = z.infer<typeof CostBreakdown>;

// 每个阶段在一组 run 上的均值；未到达该阶段的 run 按 0 计入，reached 为到达的 run 数
export const StageCost = z.object({
  stage: z.string(),
  reached: z.number(),
  costUsd: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheCreationTokens: z.number(),
  durationMs: z.number(),
  toolCalls: z.number(),
});
export type StageCost = z.infer<typeof StageCost>;

// Contracts 7.10：被测 agent 提的 friction issue（artifacts 中 kind friction），perRun 为每次 run 的平均数量
export const FrictionStats = z.object({
  perRun: z.number(),
  issues: z.array(z.object({ runId: z.string(), url: z.string(), title: z.string() })),
});
export type FrictionStats = z.infer<typeof FrictionStats>;

export const RubricQuality = z.object({
  // 得分率：得分 / 满分
  total: Distribution,
  artifacts: z.array(z.object({ artifact: z.string(), rate: Distribution })),
});

export const ReachedEnd = z.object({
  ratio: z.number().nullable(),
  values: z.array(z.object({ runId: z.string(), reached: z.boolean() })),
});

// 质量按评测类型的评分积木分项；为空表示这个 task 没有这项评分
export const Quality = z.object({
  rubric: RubricQuality.nullable(),
  // 隐藏测试：通过数 / 声明数
  passRate: Distribution.nullable(),
  // 按验收标准评分：得分 / 满分
  criteriaRate: Distribution.nullable(),
  // pr-endpoint：到达终点的比例
  reachedEnd: ReachedEnd.nullable(),
});
export type Quality = z.infer<typeof Quality>;

// 每条验收标准在一组 run 上的得分
export const CriterionMean = z.object({
  itemId: z.string(),
  criterion: z.string(),
  maxScore: z.number(),
  score: Distribution,
});

export const RubricItemMean = z.object({
  artifact: z.string(),
  itemId: z.string(),
  criterion: z.string(),
  maxScore: z.number(),
  score: Distribution,
});

export const compareGroupings = ['variant', 'model'] as const;

export const CompareCell = z.object({
  variantId: z.string(),
  // groupBy=model 时为这一格的模型；groupBy=variant 时为空（不分模型）
  model: z.string().nullable(),
  taskId: z.string(),
  runIds: z.array(z.string()),
  quality: Quality,
  // run 数为 0 时为空
  cost: z
    .object({ stages: z.array(StageCost), total: CostBreakdown, friction: FrictionStats })
    .nullable(),
  rubricItems: z.array(RubricItemMean),
  criteriaItems: z.array(CriterionMean),
});
export type CompareCell = z.infer<typeof CompareCell>;

export const CompareResult = z.object({
  variants: z.array(z.string()),
  tasks: z.array(z.string()),
  // 所选 variant 共同的 workflow 与它的评测类型（Contracts 16.5）
  workflowId: z.string(),
  kind: z.enum(['lfg', 'ic']),
  groupBy: z.enum(compareGroupings),
  includeIntervened: z.boolean(),
  includeCrossRef: z.boolean(),
  includeSourceRef: z.boolean(),
  includeCancelled: z.boolean(),
  cells: z.array(CompareCell),
});
export type CompareResult = z.infer<typeof CompareResult>;

// Contracts 7.11：run 的 requests 中指向其他评估 run 的引用（runs.cross_run_refs 的元素）
export const CrossRunRef = z.object({
  // 被引用的 run
  runId: z.string(),
  kind: z.enum(['repo', 'vault', 'ticket', 'other']),
  // 主 session 的 seq；子代理中的调用取发起该子代理的主 session 请求
  requestSeq: z.number(),
  toolCallId: z.string(),
  excerpt: z.string(),
});
export type CrossRunRef = z.infer<typeof CrossRunRef>;

// Contracts 第 13 节：从 Linear 导入的 task 的 run 读取了来源工单、来源仓库或来源仓库的 PR（runs.source_refs 的元素）
export const SourceRef = z.object({
  kind: z.enum(['ticket', 'pr', 'repo']),
  // 主 session 的 seq；子代理中的调用取发起该子代理的主 session 请求
  requestSeq: z.number(),
  toolCallId: z.string(),
  excerpt: z.string(),
});
export type SourceRef = z.infer<typeof SourceRef>;

// Compare 页面可选的 run：已评分（succeeded）与取消后评分过的 run，未标为无效
export const CompareRun = z.object({
  id: z.string(),
  variantId: z.string(),
  taskId: z.string(),
  // 被取消的 run 默认不参与对比，页面上用单独的点形状标出
  cancelled: z.boolean(),
  humanIntervened: z.boolean(),
  crossRunRefs: z.array(CrossRunRef),
  sourceRefs: z.array(SourceRef),
  // ISO 时间，web 用同一个 schema 解析响应
  createdAt: z.iso.datetime(),
  // 发起 batch 时选的模型（Contracts 16.5），Compare 按模型分组用它
  model: z.string(),
});
export type CompareRun = z.infer<typeof CompareRun>;

// kind 为 rubric 产物 id 或 db/schema 的 fixedArtifactKinds
export const RunArtifact = z.object({
  kind: z.string(),
  location: z.string(),
  snapshot: z.string().nullable(),
});
export type RunArtifact = z.infer<typeof RunArtifact>;

export const RunArtifacts = z.object({
  runId: z.string(),
  prUrl: z.string().nullable(),
  githubRepo: z.string().nullable(),
  artifacts: z.array(RunArtifact),
});
export type RunArtifacts = z.infer<typeof RunArtifacts>;

export const SkillFileDiff = z.object({
  path: z.string(),
  status: z.enum(['added', 'removed', 'modified']),
  oldContent: z.string(),
  newContent: z.string(),
  patch: z.string(),
});
export type SkillFileDiff = z.infer<typeof SkillFileDiff>;

export const SkillDiff = z.object({
  from: z.string(),
  to: z.string(),
  files: z.array(SkillFileDiff),
});
export type SkillDiff = z.infer<typeof SkillDiff>;
