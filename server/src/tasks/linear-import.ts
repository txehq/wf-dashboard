import fs from 'node:fs';
import path from 'node:path';
import createError from '@fastify/error';
import {
  bundleHead,
  createRepoBundle,
  defaultBranch,
  parsePrUrl,
  readCommit,
  readLinkedPr,
  readRemoteWorkflow,
  readWorkflowFiles,
} from '../external/github.js';
import { readIssueForImport } from '../external/linear.js';
import { draftCriteria } from './criteria-draft.js';
import {
  type CommitSource,
  type ImportPreview,
  type ImportPreviewRequest,
  issueIdentifier,
  type LinearIssueDetail,
  type LinkedPr,
} from './import-schema.js';
import type { TaskDefinition, TaskDraft } from './schema.js';
import { analyzeWorkflows } from './workflow-checks.js';

// 页面据此提示用户选择仓库
export const RepoRequired = createError<[string]>(
  'REPO_REQUIRED',
  '工单 %s 没有关联已合并的 GitHub PR，需要指定仓库',
  400,
);

// 合并的在前（按合并时间），未合并的在后
const byMerge = (a: LinkedPr, b: LinkedPr) =>
  a.mergedAt === null
    ? b.mergedAt === null
      ? 0
      : 1
    : b.mergedAt === null
      ? -1
      : a.mergedAt.localeCompare(b.mergedAt);

// 工单详情：正文原文与附件中的 GitHub PR（只读）
export async function readLinearIssue(identifier: string): Promise<LinearIssueDetail> {
  const issue = await readIssueForImport(identifier);
  const prRefs = issue.attachmentUrls.flatMap((url) => {
    const ref = parsePrUrl(url);
    return ref === null ? [] : [ref];
  });
  const linkedPrs = await Promise.all(prRefs.map((r) => readLinkedPr(r.repo, r.number)));
  return {
    identifier: issue.identifier,
    title: issue.title,
    status: issue.status,
    project: issue.project,
    url: issue.url,
    team: issue.team,
    description: issue.description,
    linkedPrs: linkedPrs.sort(byMerge),
  };
}

// 默认 commit（Contracts 第 13 节）：仓库中最早合并的关联 PR 的 base commit（这张工单的改动开始之前），
// 没有已合并的 PR 时取默认分支的最新 commit
async function defaultCommit(issue: LinearIssueDetail, repo: string) {
  const merged = issue.linkedPrs.find((p) => p.repo === repo && p.baseCommit !== null);
  if (merged?.baseCommit != null) {
    return { commit: merged.baseCommit, source: { kind: 'merged-pr', pr: merged } as CommitSource };
  }
  const branch = await defaultBranch(repo);
  const head = await readCommit(repo, branch);
  return { commit: head.sha, source: { kind: 'default-branch', branch } as CommitSource };
}

const slug = (identifier: string) => `ic-${identifier.toLowerCase()}`;

function persona(issue: LinearIssueDetail) {
  return `提出 Linear 工单 ${issue.identifier}（${issue.title}）的人，熟悉 ${issue.team} team 的这个仓库。只依据工单正文回答；工单没有写到的事，回答"按工单来"。`;
}

const HIDDEN_REQUIREMENTS = '除工单正文外没有额外的需求；被问到工单没有写到的事时，回答"按工单来"。';

// POST /api/tasks/from-linear：读工单、选仓库与 commit、分析 workflow，返回可编辑的 task 草稿，不写任何文件。
// copyRunnerLabels 取设置中副本可用的自托管 runner 标签
export async function previewLinearImport(
  request: ImportPreviewRequest,
  copyRunnerLabels: string[],
): Promise<ImportPreview> {
  const identifier = issueIdentifier(request.issue);
  if (identifier === null) throw new Error(`不是 Linear 工单地址或工单编号：${request.issue}`);
  const issue = await readLinearIssue(identifier);
  const repo = request.repo ?? issue.linkedPrs.find((p) => p.mergedAt !== null)?.repo;
  if (repo === undefined) throw new RepoRequired(issue.identifier);
  const chosen =
    request.commit === undefined
      ? await defaultCommit(issue, repo)
      : { commit: request.commit, source: { kind: 'given' } as CommitSource };
  const commit = await readCommit(repo, chosen.commit);
  const workflows = await analyzeWorkflows(
    await readWorkflowFiles(repo, commit.sha),
    readRemoteWorkflow,
    copyRunnerLabels,
  );
  // 验收标准由 judge 读工单标题与完整正文确定（Contracts 第 13 节）
  const criteria =
    request.criteria === false ? null : await draftCriteria(issue.title, issue.description);
  const task: TaskDraft = {
    id: slug(issue.identifier),
    workflow: request.workflow ?? 'dev-workflow',
    bigStage: request.bigStage ?? 'ic',
    title: issue.title,
    persona: persona(issue),
    hiddenRequirements: HIDDEN_REQUIREMENTS,
    source: {
      linear: { identifier: issue.identifier, url: issue.url },
      // 来源工单关联的、属于这个仓库的 PR；读取来源的记录只匹配这些编号
      github: {
        repo,
        prs: issue.linkedPrs.filter((p) => p.repo === repo).map((p) => p.number),
      },
    },
    ticket: {
      title: issue.title,
      // 正文原样保存；正文为空的工单由用户在表单中填写
      body: issue.description,
      acceptanceCriteria: criteria?.criteria.map((c) => c.text) ?? [],
    },
    repo: { path: 'repo.bundle', commit: commit.sha },
    requiredChecks: workflows.requiredChecks,
  };
  return {
    issue,
    repo,
    commit: commit.sha,
    commitSource: chosen.source,
    commitTitle: commit.title,
    commitDate: commit.date,
    workflows,
    criteria,
    task,
  };
}

// 保存从 Linear 导入的 task 之前：task 目录中没有 bundle、或 bundle 的 main 不是 repo.commit 时，从源仓库重新生成
export async function ensureImportedBundle(task: TaskDefinition, tasksDir: string) {
  if (task.source === undefined) return;
  if (task.repo === undefined) throw new Error(`导入的 task ${task.id} 没有 repo`);
  const bundle = path.join(tasksDir, task.id, task.repo.path);
  if (fs.existsSync(bundle) && (await bundleHead(bundle)) === task.repo.commit) return;
  await createRepoBundle(task.source.github.repo, task.repo.commit, bundle);
}
