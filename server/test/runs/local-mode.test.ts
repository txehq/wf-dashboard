import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { openDatabase } from '../../src/db/index.js';
import { runs } from '../../src/db/schema.js';
import { createRuns } from '../../src/runs/index.js';
import { createSettingsStore } from '../../src/runs/settings.js';
import { syncTasks } from '../../src/tasks/loader.js';
import { createVariants } from '../../src/variants/index.js';
import { testRepos } from '../helpers/local-repos.js';

// 本地仓库模式（Contracts 7.2）：本地仓库没有 PR，ic 的 run 在准备阶段以原文失败，不建仓库、不建工单
const db = openDatabase(
  path.join(config.repoRoot, '.work', 'test-db', `${randomUUID()}.sqlite`),
  config.migrationsDir,
);
syncTasks(db, config.tasksDir);
// 真实构建的基线 variant；wf runtime 与 cargo 缓存在 .work/test-data，跨测试运行复用
const variants = createVariants({
  db,
  dataDir: path.join(config.repoRoot, '.work', 'test-data'),
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});
const repos = testRepos();
const runsModule = createRuns({
  db,
  variants,
  settings: createSettingsStore(db),
  vaultDir: path.join(config.dataDir, 'vault'),
  product: config.evalProduct,
  runsDir: config.runsDir,
  repos,
});

afterAll(async () => {
  await runsModule.shutdown();
  db.$client.close();
});

describe('本地仓库模式下的 ic run', { timeout: 900_000 }, () => {
  test('准备阶段失败：error 写明本地仓库不支持 ic run，没有仓库与工单', async () => {
    const base = await variants.createBaseline({
      name: `W32 基线 ${randomUUID().slice(0, 8)}`,
      model: 'opus',
      effort: 'high',
    });
    await variants.build(base.id);
    const batch = runsModule.createBatch({
      variantIds: [base.id],
      taskIds: ['ic-money-format'],
      repeats: 1,
    });
    const runId = batch.runList[0]?.id ?? '';
    const deadline = Date.now() + 60_000;
    let row = db.select().from(runs).where(eq(runs.id, runId)).get();
    while (row?.status !== 'failed' && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      row = db.select().from(runs).where(eq(runs.id, runId)).get();
    }
    expect(row).toMatchObject({
      status: 'failed',
      error: `本地仓库模式（${String(repos.localDir)}）下不能发起 ic run：本地仓库没有 PR，不支持 ic run 的 PR 与评分`,
      githubRepo: null,
      linearIssueIdentifier: null,
    });
  });
});
