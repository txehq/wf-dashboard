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
import { type EvalSpec, renderMessage } from '../workflows/schema.js';
import { upsertArtifact } from './records.js';

type RunRow = typeof runs.$inferSelect;

export interface PrepareContext {
  db: Db;
  repos: RunRepos;
  vaultDir: string;
  product: string;
  run: RunRow;
  task: Task;
  // The eval configuration of the workflow of the run's variant
  stage: EvalSpec;
  signal: AbortSignal;
}

// Contracts 7.2, 16.2: the eval kind's preparation blocks create the external objects in order (repo, ticket copy,
// vault directory), then the workspace; returns the initial message from the template (the entry command is the
// workflow's id)
export async function prepareRun(ctx: PrepareContext): Promise<string> {
  const { db, repos, run, task, stage, signal } = ctx;
  const update = (values: Partial<RunRow>) => {
    db.update(runs).set(values).where(eq(runs.id, run.id)).run();
  };
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
      // wf obsidian requires the product directory to exist
      fs.mkdirSync(path.join(ctx.vaultDir, `Project ${ctx.product}`), { recursive: true });
    }
  }
  // Eval kinds that need no repo: the workspace is an empty directory
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

// The environment and variant-related arguments for starting claude: the jsonl always goes to
// <CLAUDE_CONFIG_DIR>/projects/<runId>/<sessionId>.jsonl; vault-dir sets MAGI_PRODUCT; model and effort are chosen
// when starting the batch (Contracts 16.5)
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
