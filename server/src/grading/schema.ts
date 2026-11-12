import { z } from 'zod';

// This file depends only on zod; web imports these schemas directly

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

// Detail of an ic grade; without a PR, pr and endpoint are null and all manifest tests are not-run;
// when the agent's code makes a checkout step fail or time out, error records it (all tests not-run, score 0, grading completes as usual, Contracts 7.9);
// details without this field read as null
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

// Grade detail of an ic task without hidden tests (Contracts section 13): without a PR, pr and endpoint are null, every criterion scores 0 and no judge is called
export const IcCriteriaDetail = z.object({
  pr: z
    .object({ number: z.number(), url: z.string(), branch: z.string(), head: z.string() })
    .nullable(),
  endpoint: IcEndpoint.nullable(),
  // CI results given to the judge: name and conclusion of each check on the PR head
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
  // rubric group id (artifact id of the eval kind's rubric block)
  artifact: z.string(),
  // Whether the artifact existed at grading; if not, every item scores 0 with no judge call
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

// Recorded per grading block (Contracts 16.2); null means the eval kind has no such grading
export const RunGrades = z.object({
  runId: z.string(),
  // Total cost of judge calls, counted as the grading part of the run's cost
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
  // Without hidden tests: score and reasoning per acceptance criterion
  criteria: IcCriteriaGrade.nullable(),
  // pr-endpoint: PR is not a draft and requiredChecks pass; detail is null without a PR
  endpoint: z.object({ reached: z.boolean(), detail: IcEndpoint.nullable() }).nullable(),
});
export type RunGrades = z.infer<typeof RunGrades>;

// Distribution of a value over a group of runs: spread is the sample standard deviation (n - 1), null with fewer than two runs; values let the page draw the distribution
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

// Mean of each stage over a group of runs; runs that did not reach the stage count as 0, reached is the number that did
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

// Contracts 7.10: friction issues filed by the agent under test (artifacts of kind friction); perRun is the average count per run
export const FrictionStats = z.object({
  perRun: z.number(),
  issues: z.array(z.object({ runId: z.string(), url: z.string(), title: z.string() })),
});
export type FrictionStats = z.infer<typeof FrictionStats>;

export const RubricQuality = z.object({
  // Score rate: score / max score
  total: Distribution,
  artifacts: z.array(z.object({ artifact: z.string(), rate: Distribution })),
});

export const ReachedEnd = z.object({
  ratio: z.number().nullable(),
  values: z.array(z.object({ runId: z.string(), reached: z.boolean() })),
});

// Quality per grading block of the eval kind; null means this task has no such grading
export const Quality = z.object({
  rubric: RubricQuality.nullable(),
  // Hidden tests: passed / declared
  passRate: Distribution.nullable(),
  // Acceptance criteria grading: score / max score
  criteriaRate: Distribution.nullable(),
  // pr-endpoint: share of runs that reached the endpoint
  reachedEnd: ReachedEnd.nullable(),
});
export type Quality = z.infer<typeof Quality>;

// Score of each acceptance criterion over a group of runs
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
  // With groupBy=model, this cell's model; with groupBy=variant, null (no split by model)
  model: z.string().nullable(),
  taskId: z.string(),
  runIds: z.array(z.string()),
  quality: Quality,
  // null when there are 0 runs
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
  // The workflow shared by the chosen variants and its eval kind (Contracts 16.5)
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

// Contracts 7.11: references in a run's requests to other eval runs (elements of runs.cross_run_refs)
export const CrossRunRef = z.object({
  // The referenced run
  runId: z.string(),
  kind: z.enum(['repo', 'vault', 'ticket', 'other']),
  // seq in the main session; calls in a subagent take the main session request that started the subagent
  requestSeq: z.number(),
  toolCallId: z.string(),
  excerpt: z.string(),
});
export type CrossRunRef = z.infer<typeof CrossRunRef>;

// Contracts section 13: a run of a task imported from Linear read the source ticket, source repo or a PR of the source repo (elements of runs.source_refs)
export const SourceRef = z.object({
  kind: z.enum(['ticket', 'pr', 'repo']),
  // seq in the main session; calls in a subagent take the main session request that started the subagent
  requestSeq: z.number(),
  toolCallId: z.string(),
  excerpt: z.string(),
});
export type SourceRef = z.infer<typeof SourceRef>;

// Runs selectable on the Compare page: graded (succeeded) and cancelled-then-graded runs not marked invalid
export const CompareRun = z.object({
  id: z.string(),
  variantId: z.string(),
  taskId: z.string(),
  // Cancelled runs are left out of the comparison by default and drawn with a separate point shape
  cancelled: z.boolean(),
  humanIntervened: z.boolean(),
  crossRunRefs: z.array(CrossRunRef),
  sourceRefs: z.array(SourceRef),
  // ISO time; web parses the response with the same schema
  createdAt: z.iso.datetime(),
  // Model chosen when the batch started (Contracts 16.5); Compare groups by it
  model: z.string(),
});
export type CompareRun = z.infer<typeof CompareRun>;

// kind is a rubric artifact id or one of db/schema's fixedArtifactKinds
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
