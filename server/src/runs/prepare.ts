import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { runs } from '../db/schema.js';
import { createRunTicket } from '../external/linear.js';
import type { RunRepos } from '../external/run-repos.js';
import { withRepo, withTicket } from '../tasks/loader.js';
import type { Task } from '../tasks/schema.js';
import type { RuntimeEnv } from '../variants/index.js';
import { entryOf } from '../workflows/eval-kinds.js';
import { type EvalSpec, hasGrading, renderMessage } from '../workflows/schema.js';
import { upsertArtifact } from './records.js';

type RunRow = typeof runs.$inferSelect;

export interface PrepareContext {
  db: Db;
  repos: RunRepos;
  vaultDir: string;
  product: string;
  run: RunRow;
  task: Task;
  // run 所用 variant 的 workflow 的评测配置
  stage: EvalSpec;
  signal: AbortSignal;
}

const PR_GRADING = ['hidden-tests', 'criteria-judge', 'pr-endpoint'] as const;

// Contracts 7.2、16.2：按评测类型的准备积木依次建外部对象（仓库、工单副本、vault 目录），再建 workspace；
// 返回按模板生成的初始消息（入口命令为 workflow 的 id）
export async function prepareRun(ctx: PrepareContext): Promise<string> {
  const { db, repos, run, task, stage, signal } = ctx;
  const update = (values: Partial<RunRow>) => {
    db.update(runs).set(values).where(eq(runs.id, run.id)).run();
  };
  // 本地仓库没有 PR：需要 PR 的评分积木不能在本地仓库模式下运行
  const prGrading = PR_GRADING.filter((b) => hasGrading(stage, b));
  if (repos.localDir !== null && prGrading.length > 0) {
    throw new Error(
      `本地仓库模式（${repos.localDir}）下不能发起 /${stage.id} run：本地仓库没有 PR，不支持 PR 的评分（${prGrading.join('、')}）`,
    );
  }
  let repo: string | null = null;
  let ticket: string | null = null;
  for (const brick of stage.prepare) {
    if (brick === 'empty-repo' || brick === 'repo-copy') {
      const created =
        brick === 'empty-repo'
          ? await repos.createEmpty(run.id, signal)
          : await repos.createCopy(withRepo(task), run.id, signal);
      repo = created.repo;
      update({ githubRepo: repo });
      upsertArtifact(db, run.id, 'repo', created.url, null);
    } else if (brick === 'ticket-copy') {
      const created = await createRunTicket(withTicket(task), run.id);
      ticket = created.identifier;
      update({ linearIssueId: created.uuid, linearIssueIdentifier: created.identifier });
      upsertArtifact(db, run.id, 'ticket', created.url, created.identifier);
    } else {
      // wf obsidian 要求 product 目录已存在
      fs.mkdirSync(path.join(ctx.vaultDir, `Project ${ctx.product}`), { recursive: true });
    }
  }
  // 不需要仓库的评测类型：workspace 为空目录
  if (repo === null) fs.mkdirSync(run.workspacePath, { recursive: true });
  else await repos.clone(repo, run.workspacePath, signal);
  return renderMessage(stage.message, {
    entry: entryOf(stage.id),
    input: task.input ?? null,
    runId: run.id,
    repo,
    ticket,
  });
}

// 启动 claude 的环境与 variant 相关的参数：jsonl 固定写到 <CLAUDE_CONFIG_DIR>/projects/<runId>/<sessionId>.jsonl；
// vault-dir 设 MAGI_PRODUCT；模型与 effort 在发起 batch 时选（Contracts 16.5）
export function launchSpec(
  runtime: RuntimeEnv,
  run: Pick<RunRow, 'id' | 'model' | 'effort'>,
  stage: Pick<EvalSpec, 'prepare'>,
  vault: { vaultDir: string; product: string },
): { env: Record<string, string>; variantArgs: string[] } {
  return {
    env: {
      ...runtime.env,
      CLAUDE_CODE_PROJECT_DIR_NAME: run.id,
      MAGI_VAULT: vault.vaultDir,
      ...(stage.prepare.includes('vault-dir') ? { MAGI_PRODUCT: vault.product } : {}),
    },
    variantArgs: ['--model', run.model, '--effort', run.effort, ...runtime.claudeArgs],
  };
}
