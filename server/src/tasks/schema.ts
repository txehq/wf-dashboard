import { z } from 'zod';

// 本文件只依赖 zod，web 也直接引用这里的 schema

export const rubricArtifacts = ['brief', 'research', 'plan', 'tickets'] as const;
export type RubricArtifact = (typeof rubricArtifacts)[number];

export const RubricItem = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  criterion: z.string().trim().min(1),
  maxScore: z.int().positive(),
});
export type RubricItem = z.infer<typeof RubricItem>;

export const ArtifactRubric = z.strictObject({
  artifact: z.enum(rubricArtifacts),
  items: z.array(RubricItem).min(1),
});
export type ArtifactRubric = z.infer<typeof ArtifactRubric>;

// 四个产物各出现一次、按 workflow 顺序排列，条目 id 在整份 rubric 内唯一
export const Rubric = z.array(ArtifactRubric).superRefine((groups, ctx) => {
  const order = groups.map((g) => g.artifact).join(',');
  if (order !== rubricArtifacts.join(',')) {
    ctx.addIssue({
      code: 'custom',
      message: `rubric 必须依次包含 ${rubricArtifacts.join('、')} 四组，实际为 ${order}`,
    });
  }
  const seen = new Set<string>();
  for (const id of groups.flatMap((g) => g.items.map((i) => i.id))) {
    if (seen.has(id)) ctx.addIssue({ code: 'custom', message: `rubric 条目 id 重复：${id}` });
    seen.add(id);
  }
});

export const rubricMaxScore = (rubric: ArtifactRubric[]) =>
  rubric.flatMap((g) => g.items).reduce((sum, i) => sum + i.maxScore, 0);

// task.yaml 的内容；字段顺序即文件中的书写顺序
const id = z.string().regex(/^[a-z][a-z0-9-]{1,62}$/, 'id 只能包含小写字母、数字与连字符');
const common = {
  title: z.string().trim().min(1),
  persona: z.string().trim().min(1),
  hiddenRequirements: z.string().trim().min(1),
};

export const LfgTaskDefinition = z.strictObject({
  id,
  kind: z.literal('lfg'),
  ...common,
  input: z.string().trim().min(1),
  rubric: Rubric,
});
export type LfgTaskDefinition = z.infer<typeof LfgTaskDefinition>;

export const IcTaskDefinition = z.strictObject({
  id,
  kind: z.literal('ic'),
  ...common,
  ticket: z.strictObject({
    title: z.string().trim().min(1),
    body: z.string().trim().min(1),
    acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
  }),
  repo: z.strictObject({
    // 相对 task 目录，指向 git bundle
    path: z.string().min(1),
    commit: z.string().regex(/^[0-9a-f]{40}$/, 'commit 必须是完整的 40 位 sha'),
  }),
  hiddenTests: z.strictObject({
    // 相对 task 目录，运行时复制到 checkout 的 test/hidden/
    dir: z.string().min(1),
    // 相对 task 目录的测试配置文件；评分时放在 checkout 之外，经 {configPath} 传给命令
    config: z.string().min(1),
    command: z
      .string()
      .includes('{junitPath}', { message: 'command 必须包含 {junitPath} 占位符' })
      .includes('{configPath}', { message: 'command 必须包含 {configPath} 占位符' }),
    // npm ci 与测试命令各自的时限，超时强制结束并记为评分错误
    timeoutSeconds: z.int().positive().default(600),
    // 键为相对 checkout 根目录的路径（即 JUnit classname），值为测试名；评分的分母
    manifest: z
      .record(z.string().min(1), z.array(z.string().min(1)).min(1))
      .refine((m) => Object.keys(m).length > 0, '清单不能为空'),
  }),
});
export type IcTaskDefinition = z.infer<typeof IcTaskDefinition>;

export const TaskDefinition = z.discriminatedUnion('kind', [LfgTaskDefinition, IcTaskDefinition]);
export type TaskDefinition = z.infer<typeof TaskDefinition>;

// 加载器产生的 task 额外带 task 目录的绝对路径
export type LfgTask = LfgTaskDefinition & { dir: string };
export type IcTask = IcTaskDefinition & { dir: string };
export type Task = LfgTask | IcTask;

// API 返回的 task
export const TaskRecord = z.object({
  task: TaskDefinition,
  dir: z.string(),
  updatedAt: z.number(),
});
export type TaskRecord = z.infer<typeof TaskRecord>;

// 起草 rubric 的请求：页面表单中的 lfg task 定义，rubric 可省略
export const RubricDraftRequest = LfgTaskDefinition.extend({ rubric: Rubric.optional() });
export type RubricDraftRequest = z.infer<typeof RubricDraftRequest>;

// LLM 起草 rubric 的输出；结构化输出不支持 superRefine，四组的顺序与 id 唯一由调用方再用 Rubric 校验
export const RubricDraftOutput = z.object({
  rubric: z.array(
    z.object({
      artifact: z.enum(rubricArtifacts),
      items: z.array(
        z.object({
          id: z.string().min(1),
          criterion: z.string().min(1),
          maxScore: z.int(),
        }),
      ),
    }),
  ),
});

export const RubricDraft = z.object({
  rubric: Rubric,
  model: z.string(),
  costUsd: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
});
export type RubricDraft = z.infer<typeof RubricDraft>;
