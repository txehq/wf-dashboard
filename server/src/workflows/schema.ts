import { z } from 'zod';

// workflow 的定义（Contracts 16.1）与评测类型的内部配置的结构（16.2）；本文件只依赖 zod，web 也直接引用这里的 schema

const SLUG = /^[a-z][a-z0-9-]*$/;
const slug = z.string().regex(SLUG, '只能包含小写字母、数字与连字符，以字母开头');

// 评测类型：决定准备、初始消息、结束条件、dispatch gate 与评分；task 属于其中一种（16.3）
export const evalKinds = ['lfg', 'ic'] as const;
export type EvalKind = (typeof evalKinds)[number];

// 内置的 lfg、ic：id 与评测类型同名，variant 是完整的 txe-workflow 导出，用 wf 构建（Contracts 18.6）
export const WF_WORKFLOWS = evalKinds;
export const isWfWorkflow = (id: string): id is EvalKind =>
  (WF_WORKFLOWS as readonly string[]).includes(id);

// 内置的分析 workflow（Contracts 19.2）：没有评测类型，variant 由 dashboard 自己管理；最后一个小阶段综合
export const ANALYSIS_WORKFLOW = 'session-analysis';
export const SYNTHESIZE_STAGE = 'synthesize';
// 基线 variant 中供 Codex 优化用的 skill（Contracts 19.3），不是小阶段
export const OPTIMIZE_SKILL = 'optimize-from-report';

// 服务启动时以仓库中的 yaml 为准写入的 workflow，定义只读
export const BUILTIN_WORKFLOWS = [...WF_WORKFLOWS, ANALYSIS_WORKFLOW] as const;
export type BuiltinWorkflow = (typeof BUILTIN_WORKFLOWS)[number];
export const isBuiltinWorkflow = (id: string): id is BuiltinWorkflow =>
  (BUILTIN_WORKFLOWS as readonly string[]).includes(id);

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

// task 的字段，由评测类型的积木推出（16.3）
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

function duplicates(ids: string[]): string[] {
  return [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
}

const PLACEHOLDER = /\{([A-Za-z]+)\}/g;

// 初始消息模板中的占位
export function placeholdersOf(message: string): string[] {
  return [...new Set([...message.matchAll(PLACEHOLDER)].map((m) => m[1] ?? ''))];
}

// 按模板生成初始消息；模板用到的占位没有值时抛错（内部配置的测试中已校验占位由积木提供）
export function renderMessage(message: string, values: Record<string, string | null>): string {
  return message.replace(PLACEHOLDER, (_, name: string) => {
    const value = values[name];
    if (value === undefined || value === null) throw new Error(`初始消息的占位 {${name}} 没有值`);
    return value;
  });
}

export const hasRepo = (config: Pick<EvalKindConfig, 'prepare'>) =>
  config.prepare.includes('empty-repo') || config.prepare.includes('repo-copy');

// 积木提供的占位；{entry} 是 workflow 的入口命令
export function providedPlaceholders(config: Pick<EvalKindConfig, 'prepare'>): string[] {
  return [
    'entry',
    'input',
    'runId',
    ...(hasRepo(config) ? ['repo'] : []),
    ...(config.prepare.includes('ticket-copy') ? ['ticket'] : []),
  ];
}

export function rubricOf(config: Pick<EvalKindConfig, 'grading'>): RubricArtifactSpec[] | null {
  for (const g of config.grading) if (typeof g !== 'string') return g.rubric.artifacts;
  return null;
}

export const hasGrading = (config: Pick<EvalKindConfig, 'grading'>, brick: GradingBrick) =>
  config.grading.includes(brick);

// 16.3：task 的字段由积木与评分推出
export function taskFieldsOf(config: EvalKindConfig): TaskFieldName[] {
  const fields: TaskFieldName[] = [];
  if (placeholdersOf(config.message).includes('input')) fields.push('input');
  fields.push('persona', 'hiddenRequirements');
  if (rubricOf(config) !== null) fields.push('rubric');
  if (config.prepare.includes('ticket-copy')) fields.push('ticket');
  if (config.prepare.includes('repo-copy')) fields.push('repo', 'requiredChecks');
  if (hasGrading(config, 'hidden-tests')) fields.push('hiddenTests');
  return fields;
}

// 一种评测类型的内部配置（16.2）：由积木组成，用户不编辑
export const EvalKindConfig = z
  .strictObject({
    kind: z.enum(evalKinds),
    prepare: z.array(z.enum(prepareBricks)),
    message: z.string().trim().min(1),
    // 写给模拟用户的结束条件
    done: z.string().trim().min(1),
    // 模拟用户的 prompt 加入 dispatch gate 一节，回答不得出现 go
    dispatchGate: z.literal(true).optional(),
    grading: z.array(Grading),
  })
  .superRefine((config, ctx) => {
    const issue = (message: string) => {
      ctx.addIssue({ code: 'custom', message: `评测类型 ${config.kind}：${message}` });
    };
    for (const brick of duplicates(config.prepare)) issue(`准备积木重复：${brick}`);
    if (config.prepare.includes('empty-repo') && config.prepare.includes('repo-copy')) {
      issue('empty-repo 与 repo-copy 只能选一个');
    }
    const provided = providedPlaceholders(config);
    for (const name of placeholdersOf(config.message)) {
      if (!provided.includes(name)) {
        issue(
          `message 用了积木没有提供的占位 {${name}}（可用：${provided.map((p) => `{${p}}`).join('、')}）`,
        );
      }
    }
    const named = config.grading.map((g) => (typeof g === 'string' ? g : 'rubric'));
    for (const brick of duplicates(named)) issue(`评分积木重复：${brick}`);
    for (const brick of gradingBricks) {
      if (named.includes(brick) && !config.prepare.includes('repo-copy')) {
        issue(`评分 ${brick} 要求准备积木 repo-copy`);
      }
    }
    if (named.includes('criteria-judge') && !config.prepare.includes('ticket-copy')) {
      issue('评分 criteria-judge 要求准备积木 ticket-copy');
    }
    const rubric = rubricOf(config);
    if (rubric !== null) {
      if (!config.prepare.includes('vault-dir')) issue('评分 rubric 要求准备积木 vault-dir');
      for (const id of duplicates(rubric.map((a) => a.id))) issue(`rubric 产物 id 重复：${id}`);
      for (const a of rubric) {
        if (reservedArtifactIds.includes(a.id)) {
          issue(
            `rubric 产物 id ${a.id} 与 run 的固定产物种类同名（${reservedArtifactIds.join('、')}）`,
          );
        }
      }
    }
  });
export type EvalKindConfig = z.output<typeof EvalKindConfig>;

// 一个有评测类型的 workflow 运行时取用的配置：评测类型的内部配置加上 workflow 的 id（也是入口命令 /<id>）
export type EvalSpec = EvalKindConfig & { id: string };

const SmallStage = z.strictObject({
  id: slug,
  // 再次出现只记次数（像 fix-pr）
  repeatable: z.literal(true).optional(),
  // 在本阶段中调用这些小阶段不算切换（像 fix-pr 中的 acceptance）
  allowInside: z.array(slug).optional(),
});
export type SmallStage = z.infer<typeof SmallStage>;

export const WorkflowDefinition = z
  .strictObject({
    // 也是入口命令 /<id> 与入口 skill 的名字
    id: slug,
    name: z.string().trim().min(1),
    stages: z.array(SmallStage).min(1),
  })
  .superRefine((w, ctx) => {
    const issue = (message: string, path: (string | number)[]) => {
      ctx.addIssue({ code: 'custom', message, path });
    };
    const ids = w.stages.map((s) => s.id);
    for (const id of duplicates(ids)) issue(`小阶段 id 重复：${id}`, ['stages']);
    for (const [i, s] of w.stages.entries()) {
      if (s.id === w.id) issue(`小阶段 ${s.id} 与 workflow 同名`, ['stages', i, 'id']);
      for (const inside of s.allowInside ?? []) {
        if (!ids.includes(inside)) {
          issue(`小阶段 ${s.id} 的 allowInside 引用了不存在的小阶段 ${inside}`, [
            'stages',
            i,
            'allowInside',
          ]);
        }
      }
    }
  });
export type WorkflowDefinition = z.output<typeof WorkflowDefinition>;

// workflow 要求 variant 具备的 skill：入口 skill（与 workflow id 同名）与每个小阶段的 skill（16.1）
export function requiredSkills(definition: WorkflowDefinition): string[] {
  return [definition.id, ...definition.stages.map((s) => s.id)];
}

// lfg、ic 的 txe-workflow 最新版（Contracts 29.1）：最近一次检查的结果；variantId 为这个 tag 自动导入的、没有删除的 variant
export const ReleaseView = z.object({
  tag: z.string().nullable(),
  publishedAt: z.number().nullable(),
  checkedAt: z.number(),
  variantId: z.string().nullable(),
  error: z.string().nullable(),
});
export type ReleaseView = z.infer<typeof ReleaseView>;

export const WorkflowView = z.object({
  id: z.string(),
  name: z.string(),
  evalKind: z.enum(evalKinds).nullable(),
  description: z.string().nullable(),
  // 定义只读的内置 workflow（lfg、ic、session-analysis）
  builtin: z.boolean(),
  // variant 是 txe-workflow 导出、用 wf 构建（lfg、ic）；其余由 dashboard 自己管理
  wf: z.boolean(),
  definition: WorkflowDefinition,
  variants: z.number(),
  // 只有 lfg、ic 有；还没有检查过时为空
  release: ReleaseView.nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type WorkflowView = z.infer<typeof WorkflowView>;

// POST /api/workflows（16.1、18.5）：从空白新建，同时建出第一个 variant"初稿"
export const NewWorkflowBody = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  definition: z.unknown(),
});
export type NewWorkflowBody = z.infer<typeof NewWorkflowBody>;

// PUT /api/workflows/:id：内置的 lfg、ic 只能改描述
export const UpdateWorkflowBody = z.object({
  name: z.string(),
  description: z.string(),
  definition: z.unknown(),
});
export type UpdateWorkflowBody = z.infer<typeof UpdateWorkflowBody>;
