import { z } from 'zod';

// workflow 的定义（Contracts 16.1、16.2）；本文件只依赖 zod，web 也直接引用这里的 schema

export const DEV_WORKFLOW_ID = 'dev-workflow';

const SLUG = /^[a-z][a-z0-9-]*$/;
const slug = z.string().regex(SLUG, '只能包含小写字母、数字与连字符，以字母开头');

// 准备积木，按顺序执行
export const prepareBricks = ['empty-repo', 'repo-copy', 'ticket-copy', 'vault-dir'] as const;
export type PrepareBrick = (typeof prepareBricks)[number];

// 除 rubric 以外的评分积木
export const gradingBricks = ['hidden-tests', 'criteria-judge', 'pr-endpoint'] as const;
export type GradingBrick = (typeof gradingBricks)[number];

// run 的固定产物种类（db/schema 的 fixedArtifactKinds）：rubric 产物以 id 为种类，不能与它们同名
const reservedArtifactIds = ['pr', 'repo', 'ticket', 'friction', 'acceptance', 'pr_snapshot'];

// rubric 产物的一个候选文件：frontmatter 的 kind 必须相符
const ArtifactFile = z.strictObject({ file: z.string().trim().min(1), kind: slug });

// 简写 { id, file } 等价于 files: [{ file, kind: id }]，description 为文件名
const RubricArtifactInput = z.union([
  z.strictObject({
    id: slug,
    files: z.array(ArtifactFile).min(1),
    description: z.string().trim().min(1),
    lockedPlan: z.literal(true).optional(),
    linearTickets: z.literal(true).optional(),
  }),
  z.strictObject({
    id: slug,
    file: z.string().trim().min(1),
    lockedPlan: z.literal(true).optional(),
    linearTickets: z.literal(true).optional(),
  }),
]);

export const RubricArtifactSpec = RubricArtifactInput.transform((a) =>
  'files' in a
    ? a
    : {
        id: a.id,
        files: [{ file: a.file, kind: a.id }],
        description: a.file,
        ...(a.lockedPlan === undefined ? {} : { lockedPlan: a.lockedPlan }),
        ...(a.linearTickets === undefined ? {} : { linearTickets: a.linearTickets }),
      },
);
export type RubricArtifactSpec = z.output<typeof RubricArtifactSpec>;

const RubricGrading = z.strictObject({
  rubric: z.strictObject({ artifacts: z.array(RubricArtifactSpec).min(1) }),
});

const Grading = z.union([z.enum(gradingBricks), RubricGrading]);

const SmallStage = z.strictObject({
  id: slug,
  // 再次出现只记次数（像 fix-pr）
  repeatable: z.literal(true).optional(),
  // 在本阶段中调用这些小阶段不算切换（像 fix-pr 中的 acceptance）
  allowInside: z.array(slug).optional(),
});
export type SmallStage = z.infer<typeof SmallStage>;

// task 的字段，由积木推出（16.3）
export const taskFieldNames = [
  'input',
  'persona',
  'hiddenRequirements',
  'rubric',
  'ticket',
  'repo',
  'requiredChecks',
  'hiddenTests',
] as const;
export type TaskFieldName = (typeof taskFieldNames)[number];

const BigStageInput = z.strictObject({
  // 也是入口命令 /<id>
  id: slug,
  title: z.string().trim().min(1),
  prepare: z.array(z.enum(prepareBricks)),
  message: z.string().trim().min(1),
  // 写给模拟用户的结束条件
  done: z.string().trim().min(1),
  // 模拟用户的 prompt 加入 dispatch gate 一节，回答不得出现 go
  dispatchGate: z.literal(true).optional(),
  taskFields: z.array(z.enum(taskFieldNames)).optional(),
  stages: z.array(SmallStage).min(1),
  grading: z.array(Grading),
});

export type BigStageDefinition = Omit<z.output<typeof BigStageInput>, 'taskFields'>;

const PLACEHOLDER = /\{([A-Za-z]+)\}/g;

// 初始消息模板中的占位
export function placeholdersOf(message: string): string[] {
  return [...new Set([...message.matchAll(PLACEHOLDER)].map((m) => m[1] ?? ''))];
}

// 按模板生成初始消息；模板用到的占位没有值时抛错（保存 workflow 时已校验占位由积木提供）
export function renderMessage(message: string, values: Record<string, string | null>): string {
  return message.replace(PLACEHOLDER, (_, name: string) => {
    const value = values[name];
    if (value === undefined || value === null) throw new Error(`初始消息的占位 {${name}} 没有值`);
    return value;
  });
}

export const hasRepo = (stage: Pick<BigStageDefinition, 'prepare'>) =>
  stage.prepare.includes('empty-repo') || stage.prepare.includes('repo-copy');

// 大阶段的积木提供的占位
export function providedPlaceholders(stage: Pick<BigStageDefinition, 'prepare'>): string[] {
  return [
    'input',
    'runId',
    ...(hasRepo(stage) ? ['repo'] : []),
    ...(stage.prepare.includes('ticket-copy') ? ['ticket'] : []),
  ];
}

export function rubricOf(stage: Pick<BigStageDefinition, 'grading'>): RubricArtifactSpec[] | null {
  for (const g of stage.grading) if (typeof g !== 'string') return g.rubric.artifacts;
  return null;
}

export const hasGrading = (stage: Pick<BigStageDefinition, 'grading'>, brick: GradingBrick) =>
  stage.grading.includes(brick);

// 16.3：task 的字段由积木与评分推出
export function taskFieldsOf(stage: BigStageDefinition): TaskFieldName[] {
  const fields: TaskFieldName[] = [];
  if (placeholdersOf(stage.message).includes('input')) fields.push('input');
  fields.push('persona', 'hiddenRequirements');
  if (rubricOf(stage) !== null) fields.push('rubric');
  if (stage.prepare.includes('ticket-copy')) fields.push('ticket');
  if (stage.prepare.includes('repo-copy')) fields.push('repo', 'requiredChecks');
  if (hasGrading(stage, 'hidden-tests')) fields.push('hiddenTests');
  return fields;
}

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x) => b.includes(x));

function duplicates(ids: string[]): string[] {
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
}

const BigStage = BigStageInput.superRefine((stage, ctx) => {
  const issue = (message: string) => {
    ctx.addIssue({ code: 'custom', message: `大阶段 ${stage.id}：${message}` });
  };
  const ids = stage.stages.map((s) => s.id);
  for (const id of duplicates(ids)) issue(`小阶段 id 重复：${id}`);
  for (const s of stage.stages) {
    for (const inside of s.allowInside ?? []) {
      if (!ids.includes(inside)) {
        issue(`小阶段 ${s.id} 的 allowInside 引用了不存在的小阶段 ${inside}`);
      }
    }
  }
  for (const brick of duplicates(stage.prepare)) issue(`准备积木重复：${brick}`);
  if (stage.prepare.includes('empty-repo') && stage.prepare.includes('repo-copy')) {
    issue('empty-repo 与 repo-copy 只能选一个');
  }
  const provided = providedPlaceholders(stage);
  for (const name of placeholdersOf(stage.message)) {
    if (!provided.includes(name)) {
      issue(
        `message 用了积木没有提供的占位 {${name}}（可用：${provided.map((p) => `{${p}}`).join('、')}）`,
      );
    }
  }
  const named = stage.grading.map((g) => (typeof g === 'string' ? g : 'rubric'));
  for (const brick of duplicates(named)) issue(`评分积木重复：${brick}`);
  for (const brick of ['hidden-tests', 'criteria-judge', 'pr-endpoint'] as const) {
    if (named.includes(brick) && !stage.prepare.includes('repo-copy')) {
      issue(`评分 ${brick} 要求准备积木 repo-copy`);
    }
  }
  if (named.includes('criteria-judge') && !stage.prepare.includes('ticket-copy')) {
    issue('评分 criteria-judge 要求准备积木 ticket-copy');
  }
  const rubric = rubricOf(stage);
  if (rubric !== null) {
    if (!stage.prepare.includes('vault-dir')) issue('评分 rubric 要求准备积木 vault-dir');
    for (const id of duplicates(rubric.map((a) => a.id))) issue(`rubric 产物 id 重复：${id}`);
    for (const a of rubric) {
      if (reservedArtifactIds.includes(a.id)) {
        issue(
          `rubric 产物 id ${a.id} 与 run 的固定产物种类同名（${reservedArtifactIds.join('、')}）`,
        );
      }
    }
  }
  if (stage.taskFields !== undefined) {
    const derived = taskFieldsOf(stage);
    if (!sameSet(stage.taskFields, derived)) {
      issue(`taskFields 为 ${stage.taskFields.join(', ')}，由积木推出的是 ${derived.join(', ')}`);
    }
  }
}).transform((stage): BigStageDefinition => {
  // taskFields 由积木推出，校验后不保存
  const out: Partial<typeof stage> = { ...stage };
  delete out.taskFields;
  return out as BigStageDefinition;
});

export const WorkflowDefinition = z
  .strictObject({
    id: slug,
    name: z.string().trim().min(1),
    bigStages: z.array(BigStage).min(1),
  })
  .superRefine((w, ctx) => {
    for (const id of duplicates(w.bigStages.map((s) => s.id))) {
      ctx.addIssue({ code: 'custom', message: `大阶段 id 重复：${id}` });
    }
  });
export type WorkflowDefinition = z.output<typeof WorkflowDefinition>;
// 写出（YAML 与 API 请求）时的形状
export type WorkflowDefinitionInput = z.input<typeof WorkflowDefinition>;

export function bigStageOf(definition: WorkflowDefinition, id: string): BigStageDefinition {
  const stage = definition.bigStages.find((s) => s.id === id);
  if (stage === undefined) throw new Error(`workflow ${definition.id} 没有大阶段 ${id}`);
  return stage;
}

// workflow 要求 variant 具备的 skill：每个大阶段的入口 skill 与每个小阶段的 skill（16.1）
export function requiredSkills(definition: WorkflowDefinition): string[] {
  return [...new Set(definition.bigStages.flatMap((s) => [s.id, ...s.stages.map((x) => x.id)]))];
}

export const WorkflowView = z.object({
  id: z.string(),
  name: z.string(),
  baseVariantId: z.string().nullable(),
  builtin: z.boolean(),
  definition: z.unknown(),
  // 按大阶段：由积木推出的 task 字段
  taskFields: z.record(z.string(), z.array(z.enum(taskFieldNames))),
  variants: z.number(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type WorkflowView = z.infer<typeof WorkflowView>;
