import { z } from 'zod';
import {
  artifactKinds,
  gradingStatuses,
  runMessageRoles,
  runStatuses,
  workflows,
} from '../db/schema.js';
import { CrossRunRef } from '../grading/schema.js';
import { StageReport } from '../stages/report.js';

// Runs API 与 run.* 事件共用的形状（Contracts 7.6）

export const AskQuestionView = z.object({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(z.object({ label: z.string(), description: z.string().optional() })),
  multiSelect: z.boolean().optional(),
});

export const RunMessageView = z.object({
  id: z.number(),
  seq: z.number(),
  role: z.enum(runMessageRoles),
  content: z.string(),
  costUsd: z.number(),
  payload: z.unknown().nullable(),
  createdAt: z.number(),
});
export type RunMessageView = z.infer<typeof RunMessageView>;

// 待回答的提问：一轮结束时的文字，或 AskUserQuestion
export const Pending = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string(), since: z.number() }),
  z.object({
    kind: z.literal('questions'),
    requestId: z.string(),
    questions: z.array(AskQuestionView),
    since: z.number(),
  }),
]);
export type Pending = z.infer<typeof Pending>;

export const ArtifactView = z.object({
  kind: z.enum(artifactKinds),
  location: z.string(),
  snapshot: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type ArtifactView = z.infer<typeof ArtifactView>;

export const RunMode = z.enum(['simulated', 'human']);
export type RunMode = z.infer<typeof RunMode>;

export const CurrentStage = z
  .object({ workflow: z.enum(workflows), stage: z.string(), status: z.string() })
  .nullable();

export const RunSummary = z.object({
  id: z.string(),
  batchId: z.string(),
  taskId: z.string(),
  taskKind: z.enum(workflows),
  taskTitle: z.string(),
  variantId: z.string(),
  variantName: z.string(),
  repeatIndex: z.number(),
  status: z.enum(runStatuses),
  currentStage: CurrentStage,
  costUsd: z.number(),
  // 从开始准备到结束（未结束时到现在）
  durationMs: z.number().nullable(),
  humanIntervened: z.boolean(),
  crossRunRefs: z.array(CrossRunRef),
  invalidReason: z.string().nullable(),
  grading: z.object({ status: z.enum(gradingStatuses), error: z.string().nullable() }),
  error: z.string().nullable(),
  createdAt: z.number(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
});
export type RunSummary = z.infer<typeof RunSummary>;

export const CostBreakdown = z.object({
  agent: z.number(),
  simulatedUser: z.number(),
  grading: z.number(),
  total: z.number(),
});

export const RunDetail = RunSummary.extend({
  sessionId: z.string(),
  workspacePath: z.string(),
  mode: RunMode,
  pending: Pending.nullable(),
  stages: StageReport.nullable(),
  messages: z.array(RunMessageView),
  artifacts: z.array(ArtifactView),
  costs: CostBreakdown,
  links: z.object({
    repo: z.string().nullable(),
    ticket: z.string().nullable(),
    pr: z.string().nullable(),
    vault: z.string().nullable(),
  }),
  // 被测 agent 在 txehq/txe-workflow 提的 issue 与评论（Contracts 7.10）
  friction: z.array(z.object({ url: z.string(), title: z.string() })),
});
export type RunDetail = z.infer<typeof RunDetail>;

export const BatchSummary = z.object({
  id: z.string(),
  repeats: z.number(),
  variantIds: z.array(z.string()),
  taskIds: z.array(z.string()),
  createdAt: z.number(),
  runs: z.number(),
  // 每种 status 的 run 数
  statusCounts: z.record(z.string(), z.number()),
  costUsd: z.number(),
});
export type BatchSummary = z.infer<typeof BatchSummary>;

export const BatchDetail = BatchSummary.extend({ runList: z.array(RunSummary) });
export type BatchDetail = z.infer<typeof BatchDetail>;
