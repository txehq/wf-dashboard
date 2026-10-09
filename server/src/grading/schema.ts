import { z } from 'zod';
import { rubricArtifacts } from '../tasks/schema.js';

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

// ic 评分的明细；没有 PR 时 pr 与 endpoint 为空，清单中的测试全部为 not-run
export const IcDetail = z.object({
  pr: z
    .object({ number: z.number(), url: z.string(), branch: z.string(), head: z.string() })
    .nullable(),
  outcomes: z.array(Outcome),
  fileErrors: z.array(FileError),
  endpoint: IcEndpoint.nullable(),
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

export const ArtifactGrade = z.object({
  artifact: z.enum(rubricArtifacts),
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

export const RunGrades = z.object({
  runId: z.string(),
  kind: z.enum(['lfg', 'ic']),
  // judge 调用的花费合计，计入 run 成本的评分一项
  costUsd: z.number(),
  lfg: z
    .object({ artifacts: z.array(ArtifactGrade), score: z.number(), maxScore: z.number() })
    .nullable(),
  ic: z
    .object({
      testsPassed: z.number(),
      testsDeclared: z.number(),
      reachedEnd: z.boolean(),
      detail: IcDetail,
    })
    .nullable(),
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
  stageCheck: z.number(),
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

export const LfgQuality = z.object({
  kind: z.literal('lfg'),
  // 得分率：得分 / 满分
  total: Distribution,
  artifacts: z.array(z.object({ artifact: z.enum(rubricArtifacts), rate: Distribution })),
});

export const IcQuality = z.object({
  kind: z.literal('ic'),
  // 通过数 / 声明数
  passRate: Distribution,
  reachedEnd: z.object({
    ratio: z.number().nullable(),
    values: z.array(z.object({ runId: z.string(), reached: z.boolean() })),
  }),
});

export const RubricItemMean = z.object({
  artifact: z.enum(rubricArtifacts),
  itemId: z.string(),
  criterion: z.string(),
  maxScore: z.number(),
  score: Distribution,
});

export const CompareCell = z.object({
  variantId: z.string(),
  taskId: z.string(),
  kind: z.enum(['lfg', 'ic']),
  runIds: z.array(z.string()),
  quality: z.discriminatedUnion('kind', [LfgQuality, IcQuality]),
  // run 数为 0 时为空
  cost: z.object({ stages: z.array(StageCost), total: CostBreakdown }).nullable(),
  rubricItems: z.array(RubricItemMean),
});
export type CompareCell = z.infer<typeof CompareCell>;

export const CompareResult = z.object({
  variants: z.array(z.string()),
  tasks: z.array(z.string()),
  includeIntervened: z.boolean(),
  includeCrossRef: z.boolean(),
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

// Compare 页面可选的 run：全部已评分（succeeded）的 run
export const CompareRun = z.object({
  id: z.string(),
  variantId: z.string(),
  taskId: z.string(),
  humanIntervened: z.boolean(),
  crossRunRefs: z.array(CrossRunRef),
  // ISO 时间，web 用同一个 schema 解析响应
  createdAt: z.iso.datetime(),
});
export type CompareRun = z.infer<typeof CompareRun>;

// 与 db/schema 的 artifactKinds 相同
export const RunArtifact = z.object({
  kind: z.enum(['brief', 'research', 'plan', 'tickets', 'pr', 'repo', 'ticket', 'friction']),
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
