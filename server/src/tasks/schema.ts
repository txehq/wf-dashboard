import { z } from 'zod';
import type { BigStageDefinition } from '../workflows/schema.js';
import { rubricOf, taskFieldsOf, type TaskFieldName } from '../workflows/schema.js';

// 本文件只依赖 zod，web 也直接引用这里的 schema

// task 目录内的相对路径：不能是绝对路径，不能经过 ..（加载与评分时按它复制文件）
const taskPath = z
  .string()
  .min(1)
  .refine(
    (p) => !p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..'),
    '必须是 task 目录内的相对路径（不能以 / 开头，不能含 .. 或反斜杠）',
  );

const slug = z.string().regex(/^[a-z][a-z0-9-]*$/);

export const RUBRIC_ITEM_ID = /^[a-z][a-z0-9-]*$/;

export const RubricItem = z.strictObject({
  id: z.string().regex(RUBRIC_ITEM_ID),
  criterion: z.string().trim().min(1),
  maxScore: z.int().positive(),
});
export type RubricItem = z.infer<typeof RubricItem>;

export const ArtifactRubric = z.strictObject({
  // 大阶段 rubric 评分的产物 id（Contracts 16.2），例如 brief、research
  artifact: slug,
  items: z.array(RubricItem).min(1),
});
export type ArtifactRubric = z.infer<typeof ArtifactRubric>;

// 每组只出现一次，条目 id 在整份 rubric 内唯一；分组与大阶段产物的对应在加载 task 时检查
export const Rubric = z.array(ArtifactRubric).superRefine((groups, ctx) => {
  const artifacts = groups.map((g) => g.artifact);
  for (const a of new Set(artifacts.filter((x, i) => artifacts.indexOf(x) !== i))) {
    ctx.addIssue({ code: 'custom', message: `rubric 分组重复：${a}` });
  }
  const seen = new Set<string>();
  for (const id of groups.flatMap((g) => g.items.map((i) => i.id))) {
    if (seen.has(id)) ctx.addIssue({ code: 'custom', message: `rubric 条目 id 重复：${id}` });
    seen.add(id);
  }
});

export const rubricMaxScore = (rubric: ArtifactRubric[]) =>
  rubric.flatMap((g) => g.items).reduce((sum, i) => sum + i.maxScore, 0);

const id = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/, 'id 只能包含小写字母、数字与连字符');

const Ticket = z.strictObject({
  title: z.string().trim().min(1),
  // 不做 trim：从 Linear 导入的正文原样保存，读回逐字节相同
  body: z.string().refine((s) => s.trim() !== '', '正文不能为空'),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
});
export type Ticket = z.infer<typeof Ticket>;

// 从 Linear 导入的 task 的来源（Contracts 第 13 节）：原工单只读取；保存时按 github.repo 与 repo.commit 生成 bundle
export const IcTaskSource = z.strictObject({
  linear: z.strictObject({
    identifier: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/),
    url: z.url(),
  }),
  github: z.strictObject({
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, '仓库写作 owner/name'),
    // 来源工单的 GitHub 附件中属于该仓库的 PR 编号；读取来源的记录只匹配这些编号
    prs: z.array(z.int().positive()).default([]),
  }),
});
export type IcTaskSource = z.infer<typeof IcTaskSource>;

const TaskRepo = z.strictObject({
  // 相对 task 目录，指向 git bundle
  path: taskPath,
  commit: z.string().regex(/^[0-9a-f]{40}$/, 'commit 必须是完整的 40 位 sha'),
});
export type TaskRepo = z.infer<typeof TaskRepo>;

export const HiddenTests = z.strictObject({
  // 相对 task 目录，运行时复制到 checkout 的 test/hidden/
  dir: taskPath,
  // 相对 task 目录的测试配置文件；评分时放在 checkout 之外，经 {configPath} 传给命令
  config: taskPath,
  command: z
    .string()
    .includes('{junitPath}', { message: 'command 必须包含 {junitPath} 占位符' })
    .includes('{configPath}', { message: 'command 必须包含 {configPath} 占位符' }),
  // npm ci 与测试命令各自的时限，超时强制结束并记为评分错误
  timeoutSeconds: z.int().positive().default(600),
  // 键为相对 checkout 根目录的路径（即 JUnit classname），值为测试名；评分的分母。同一文件中测试名不能重复
  manifest: z
    .record(
      z.string().min(1),
      z
        .array(z.string().min(1))
        .min(1)
        .refine((names) => new Set(names).size === names.length, '同一文件中的测试名不能重复'),
    )
    .refine((m) => Object.keys(m).length > 0, '清单不能为空'),
});
export type HiddenTests = z.infer<typeof HiddenTests>;

const RequiredChecks = z
  .array(z.string().trim().min(1))
  .refine((names) => new Set(names).size === names.length, 'requiredChecks 不能重复');

// task.yaml 的内容（Contracts 16.3）：绑定一个 workflow 的一个大阶段，可选字段由大阶段的积木决定（checkTaskFields）；
// 字段顺序即文件中的书写顺序
const taskFields = {
  id,
  workflow: slug,
  bigStage: slug,
  title: z.string().trim().min(1),
  persona: z.string().trim().min(1),
  hiddenRequirements: z.string().trim().min(1),
  // 初始消息中 {input} 的内容，例如 /lfg 的输入原文
  input: z.string().trim().min(1).optional(),
  rubric: Rubric.optional(),
  source: IcTaskSource.optional(),
  ticket: Ticket.optional(),
  repo: TaskRepo.optional(),
  // 终点要求通过的 check（GitHub 报告的 check 名）；createRunRepo 以它建 ruleset，为空时不建、终点只要求 PR 不是 draft
  requiredChecks: RequiredChecks.optional(),
  // 大阶段同时有 criteria-judge 时可以没有：judge 按验收标准逐条评分
  hiddenTests: HiddenTests.optional(),
};

export const TaskDefinition = z.strictObject(taskFields);
export type TaskDefinition = z.infer<typeof TaskDefinition>;

// 从 Linear 导入的预览：工单没有验收标准一节（或没有正文）时为空，由用户在表单中补上后才能保存
export const TaskDraft = z.strictObject({
  ...taskFields,
  ticket: Ticket.extend({
    body: z.string(),
    acceptanceCriteria: z.array(z.string().trim().min(1)),
  }),
});
export type TaskDraft = z.infer<typeof TaskDraft>;

// task 中按积木出现的字段（id、workflow、bigStage、title 总是有）
const optionalFields: readonly (keyof TaskDefinition)[] = [
  'input',
  'persona',
  'hiddenRequirements',
  'rubric',
  'source',
  'ticket',
  'repo',
  'requiredChecks',
  'hiddenTests',
];

// 16.3：字段按大阶段的积木校验，缺少或多出时给出原文；没有问题时为空数组
export function taskFieldIssues(task: TaskDefinition, stage: BigStageDefinition): string[] {
  const derived: readonly TaskFieldName[] = taskFieldsOf(stage);
  // 同时有 criteria-judge 时隐藏测试可以没有；source 只属于有工单的 task
  const optional = new Set<string>([
    ...(stage.grading.includes('criteria-judge') ? ['hiddenTests'] : []),
    ...(derived.includes('ticket') ? ['source'] : []),
  ]);
  const required = derived.filter((f) => !optional.has(f));
  const allowed = new Set<string>([...derived, ...optional]);
  const present = optionalFields.filter((f) => task[f] !== undefined);
  const where = `task ${task.id}（${task.workflow} 的大阶段 ${task.bigStage}）`;
  const issues: string[] = [];
  const missing = required.filter((f) => task[f] === undefined);
  if (missing.length > 0) issues.push(`${where}缺少字段：${missing.join('、')}`);
  const extra = present.filter((f) => !allowed.has(f));
  if (extra.length > 0) issues.push(`${where}多出字段：${extra.join('、')}`);
  const rubric = rubricOf(stage);
  if (rubric !== null && task.rubric !== undefined) {
    const expected = rubric.map((a) => a.id).join(',');
    const actual = task.rubric.map((g) => g.artifact).join(',');
    if (expected !== actual) {
      issues.push(
        `${where}的 rubric 必须依次包含 ${expected.replaceAll(',', '、')} 各组，实际为 ${actual}`,
      );
    }
  }
  return issues;
}

// 加载器产生的 task 额外带 task 目录的绝对路径
export type Task = TaskDefinition & { dir: string };
export type RubricTask = Task & { rubric: ArtifactRubric[] };
export type TicketTask = Task & { ticket: Ticket };
// 有副本仓库的 task（repo-copy）
export type RepoTask = Task & { repo: TaskRepo; requiredChecks: string[] };
// 有 PR 的 task：副本仓库加工单（criteria-judge）
export type PrTask = RepoTask & TicketTask;
// 带隐藏测试的 task：评分跑隐藏测试
export type TestsTask = RepoTask & { hiddenTests: HiddenTests };

// API 返回的 task
export const TaskRecord = z.object({
  task: TaskDefinition,
  dir: z.string(),
  updatedAt: z.number(),
});
export type TaskRecord = z.infer<typeof TaskRecord>;

// 起草 rubric 的请求：页面表单中的 task 定义（rubric 可省略），大阶段必须有 rubric 评分
export const RubricDraftRequest = TaskDefinition;
export type RubricDraftRequest = z.infer<typeof RubricDraftRequest>;

// LLM 起草 rubric 的输出；分组限定为大阶段的产物 id。结构化输出不支持 superRefine，
// 分组的顺序与 id 唯一由调用方再用 Rubric 与 taskFieldIssues 校验。
// id 的写法与 RubricItem 相同，每组 4 到 8 条（与起草 prompt 的要求相同），不满足时以 zod 的原文失败
export function rubricDraftOutput(artifacts: [string, ...string[]]) {
  return z.object({
    rubric: z.array(
      z.object({
        artifact: z.enum(artifacts),
        items: z
          .array(
            z.object({
              id: z.string().regex(RUBRIC_ITEM_ID),
              criterion: z.string().min(1),
              maxScore: z.int(),
            }),
          )
          .min(4)
          .max(8),
      }),
    ),
  });
}
export type RubricDraftOutput = z.infer<ReturnType<typeof rubricDraftOutput>>;

export const RubricDraft = z.object({
  rubric: Rubric,
  model: z.string(),
  costUsd: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
});
export type RubricDraft = z.infer<typeof RubricDraft>;
