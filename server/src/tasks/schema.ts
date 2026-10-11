import { z } from 'zod';

// 本文件只依赖 zod，web 也直接引用这里的 schema

// task 目录内的相对路径：不能是绝对路径，不能经过 ..（加载与评分时按它复制文件）
const taskPath = z
  .string()
  .min(1)
  .refine(
    (p) => !p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..'),
    '必须是 task 目录内的相对路径（不能以 / 开头，不能含 .. 或反斜杠）',
  );

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

const IcTicket = z.strictObject({
  title: z.string().trim().min(1),
  // 不做 trim：从 Linear 导入的正文原样保存，读回逐字节相同
  body: z.string().refine((s) => s.trim() !== '', '正文不能为空'),
  acceptanceCriteria: z.array(z.string().trim().min(1)).min(1),
});

// 从 Linear 导入的 task 的来源（Contracts 第 13 节）：原工单只读取；保存时按 github.repo 与 repo.commit 生成 bundle
export const IcTaskSource = z.strictObject({
  linear: z.strictObject({
    identifier: z.string().regex(/^[A-Z][A-Z0-9]*-\d+$/),
    url: z.url(),
  }),
  github: z.strictObject({
    repo: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, '仓库写作 owner/name'),
  }),
});
export type IcTaskSource = z.infer<typeof IcTaskSource>;

const icFields = {
  id,
  kind: z.literal('ic'),
  ...common,
  source: IcTaskSource.optional(),
  ticket: IcTicket,
  repo: z.strictObject({
    // 相对 task 目录，指向 git bundle
    path: taskPath,
    commit: z.string().regex(/^[0-9a-f]{40}$/, 'commit 必须是完整的 40 位 sha'),
  }),
  // 终点要求通过的 check（GitHub 报告的 check 名）；createRunRepo 以它建 ruleset，为空时不建、终点只要求 PR 不是 draft
  requiredChecks: z
    .array(z.string().trim().min(1))
    .refine((names) => new Set(names).size === names.length, 'requiredChecks 不能重复'),
  // 没有隐藏测试时 judge 按验收标准逐条评分
  hiddenTests: z
    .strictObject({
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
    })
    .optional(),
};

export const IcTaskDefinition = z.strictObject(icFields);
export type IcTaskDefinition = z.infer<typeof IcTaskDefinition>;
export type IcHiddenTests = NonNullable<IcTaskDefinition['hiddenTests']>;

// 从 Linear 导入的预览：工单没有验收标准一节（或没有正文）时为空，由用户在表单中补上后才能保存
export const IcTaskDraft = z.strictObject({
  ...icFields,
  ticket: IcTicket.extend({
    body: z.string(),
    acceptanceCriteria: z.array(z.string().trim().min(1)),
  }),
});
export type IcTaskDraft = z.infer<typeof IcTaskDraft>;

export const TaskDefinition = z.discriminatedUnion('kind', [LfgTaskDefinition, IcTaskDefinition]);
export type TaskDefinition = z.infer<typeof TaskDefinition>;

// 加载器产生的 task 额外带 task 目录的绝对路径
export type LfgTask = LfgTaskDefinition & { dir: string };
export type IcTask = IcTaskDefinition & { dir: string };
// 带隐藏测试的 ic task：评分跑隐藏测试（没有隐藏测试时按验收标准评分）
export type IcTaskWithTests = IcTask & { hiddenTests: IcHiddenTests };
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
