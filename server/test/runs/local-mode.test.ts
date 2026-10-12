import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { openDatabase } from '../../src/db/index.js';
import { artifacts, runs } from '../../src/db/schema.js';
import { recordPrSnapshot, StoredPrSnapshot } from '../../src/grading/pr-snapshot.js';
import { exportRun } from '../../src/insights/export.js';
import { createRuns } from '../../src/runs/index.js';
import { createSettingsStore } from '../../src/runs/settings.js';
import { syncTasks } from '../../src/tasks/loader.js';
import { createVariants } from '../../src/variants/index.js';
import { insertRun, insertVariant } from '../grading/seed.js';
import { testRunId } from '../helpers/ic-fixture.js';
import { testRepos } from '../helpers/local-repos.js';
import { openTestDb } from '../stages/db.js';

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

describe('本地仓库模式下的 PR 快照与导出', () => {
  test('lfg run 的本地仓库没有 PR：快照为 null，location 为 file:// 地址；没有快照时导出记为 local', async () => {
    const { db: testDb, close } = openTestDb();
    syncTasks(testDb, config.tasksDir);
    insertVariant(testDb, 'baseline');
    const created = await repos.createEmpty(testRunId('w32-lfg'), new AbortController().signal);
    const runId = testRunId('w32-snap');
    insertRun(testDb, {
      id: runId,
      taskId: 'lfg-calculator',
      variantId: 'baseline',
      githubRepo: created.repo,
    });
    const run = testDb.select().from(runs).where(eq(runs.id, runId)).get();
    if (run === undefined) throw new Error('run 不存在');
    await recordPrSnapshot(testDb, run);
    const stored = testDb
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.runId, runId), eq(artifacts.kind, 'pr_snapshot')))
      .get();
    expect(stored?.location).toBe(created.url);
    expect(StoredPrSnapshot.parse(JSON.parse(stored?.snapshot ?? 'null')).pr).toBeNull();

    const old = testRunId('w32-old');
    insertRun(testDb, {
      id: old,
      taskId: 'lfg-calculator',
      variantId: 'baseline',
      githubRepo: created.repo,
    });
    expect(((await exportRun(testDb, old)) as { pr: unknown }).pr).toEqual({
      source: 'local',
      pr: null,
    });
    close();
  });
});

describe('本地仓库模式下的 ic run', { timeout: 900_000 }, () => {
  test('准备阶段失败：error 写明本地仓库不支持 ic run，没有仓库与工单', async () => {
    const base = await variants.createBaseline({
      name: `W32 基线 ${randomUUID().slice(0, 8)}`,
      workflowId: 'ic',
    });
    await variants.build(base.id);
    const batch = runsModule.createBatch({
      variantIds: [base.id],
      taskIds: ['ic-money-format'],
      repeats: 1,
      model: 'opus',
      effort: 'high',
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
      error: `本地仓库模式（${String(repos.localDir)}）下不能发起 /ic run：本地仓库没有 PR，不支持 PR 的评分（hidden-tests、criteria-judge、pr-endpoint）`,
      githubRepo: null,
      linearIssueIdentifier: null,
    });
  });
});
