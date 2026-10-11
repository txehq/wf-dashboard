import { z } from 'zod';
import { IcTaskDraft } from './schema.js';

// 本文件只依赖 zod，web 也直接引用这里的 schema：从 Linear 导入 ic task 的 API（Contracts 第 13 节）

// 一个 job（matrix 展开后的一个实例，或 reusable workflow 中的一个 job）在副本仓库中的情况
export const workflowJobStatuses = [
  // 能在副本的 PR 上运行，check 名进入 requiredChecks 的默认值
  'required',
  // runs-on 不是 GitHub 托管 runner（例如 arc-linux-dind），副本中没有 runner
  'self-hosted',
  // GitHub 已停用的托管 runner 标签
  'retired',
  // needs 的 job 无法运行，它也不会运行
  'blocked',
  // workflow 不由指向 main 的 pull_request 触发
  'not-on-pr',
  // pull_request 带 paths 过滤：只在改动特定路径时运行
  'path-filtered',
  // runs-on、check 名或 matrix 用到了运行时才知道的值
  'unresolved',
  // workflow 文件本身不合法，GitHub 不会运行
  'invalid',
] as const;
export type WorkflowJobStatus = (typeof workflowJobStatuses)[number];

export const WorkflowJob = z.object({
  // 相对仓库根目录的 workflow 文件
  workflow: z.string(),
  jobId: z.string(),
  // GitHub 报告的 check 名；无法确定时为空
  checkName: z.string().nullable(),
  // runs-on 的标签，多个以逗号连接；无法确定时为空
  runsOn: z.string().nullable(),
  status: z.enum(workflowJobStatuses),
  reason: z.string(),
  // push 到 main 时也会运行（createRunRepo 推送起始代码后等待这类 required check）
  onPush: z.boolean(),
});
export type WorkflowJob = z.infer<typeof WorkflowJob>;

export const WorkflowAnalysis = z.object({
  jobs: z.array(WorkflowJob),
  // status 为 required 的 check 名，按出现顺序去重
  requiredChecks: z.array(z.string()),
});
export type WorkflowAnalysis = z.infer<typeof WorkflowAnalysis>;

export const LinkedPr = z.object({
  repo: z.string(),
  number: z.number(),
  url: z.string(),
  title: z.string(),
  state: z.string(),
  mergedAt: z.string().nullable(),
  // PR 的 base commit；未合并的 PR 为空
  baseCommit: z.string().nullable(),
});
export type LinkedPr = z.infer<typeof LinkedPr>;

export const LinearIssueDetail = z.object({
  identifier: z.string(),
  title: z.string(),
  status: z.string(),
  project: z.string().nullable(),
  url: z.string(),
  team: z.string(),
  // Linear 返回的 markdown 原文
  description: z.string(),
  // 正文中"验收标准 / Acceptance criteria"一节的列表项；没有这一节时为空
  acceptanceCriteria: z.array(z.string()),
  // 工单附件中的 GitHub PR，按合并时间排序，未合并的在后
  linkedPrs: z.array(LinkedPr),
});
export type LinearIssueDetail = z.infer<typeof LinearIssueDetail>;

// commit 默认值的来源
export const CommitSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('merged-pr'), pr: LinkedPr }),
  z.object({ kind: z.literal('default-branch'), branch: z.string() }),
  z.object({ kind: z.literal('given') }),
]);
export type CommitSource = z.infer<typeof CommitSource>;

const repoName = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, '仓库写作 owner/name');

// 工单地址（https://linear.app/<workspace>/issue/TXE-3546/<slug>）或工单编号（TXE-3546）中的编号；都不是时为 null
export function issueIdentifier(input: string): string | null {
  const text = input.trim();
  const bare = /^([A-Z][A-Z0-9]*-\d+)$/.exec(text);
  if (bare?.[1] !== undefined) return bare[1];
  const url = /^https:\/\/linear\.app\/[^/]+\/issue\/([A-Z][A-Z0-9]*-\d+)(?:[/?#].*)?$/.exec(text);
  return url?.[1] ?? null;
}

export const ImportPreviewRequest = z.object({
  // 用户粘贴的工单地址或编号
  issue: z.string().superRefine((s, ctx) => {
    if (issueIdentifier(s) === null) {
      ctx.addIssue({ code: 'custom', message: `不是 Linear 工单地址或工单编号：${s}` });
    }
  }),
  // 省略时取工单关联的已合并 PR 的仓库
  repo: repoName.optional(),
  // 省略时按 Contracts 第 13 节取默认值
  commit: z
    .string()
    .regex(/^[0-9a-f]{40}$/, 'commit 必须是完整的 40 位 sha')
    .optional(),
});
export type ImportPreviewRequest = z.infer<typeof ImportPreviewRequest>;

// POST /api/tasks/from-linear 的结果：不保存。task 是可以直接交给 POST /api/tasks 的 ic task 定义
export const ImportPreview = z.object({
  issue: LinearIssueDetail,
  repo: repoName,
  commit: z.string(),
  commitSource: CommitSource,
  // commit 的标题行与时间，供页面核对
  commitTitle: z.string(),
  commitDate: z.string(),
  workflows: WorkflowAnalysis,
  task: IcTaskDraft,
});
export type ImportPreview = z.infer<typeof ImportPreview>;
