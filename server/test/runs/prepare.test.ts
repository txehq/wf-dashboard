import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { artifacts, batches, runs } from '../../src/db/schema.js';
import { createRuns } from '../../src/runs/index.js';
import { launchSpec, prepareRun } from '../../src/runs/prepare.js';
import { createSettingsStore } from '../../src/runs/settings.js';
import { loadTask, syncTasks } from '../../src/tasks/loader.js';
import { createVariants } from '../../src/variants/index.js';
import { createWorkflows, evalSpecOf, loadWorkflow } from '../../src/workflows/index.js';
import { testRunId } from '../helpers/ic-fixture.js';
import { testRepos } from '../helpers/local-repos.js';
import { openTestDb } from '../stages/db.js';

// Contracts 16.2：准备、初始消息与启动 claude 的参数按评测类型的积木生成，入口命令为 workflow 的 id；只测到启动 claude 之前。
// 内置 lfg 生成的初始消息与环境与原来写死的格式相同；复制出的 mylfg 以 /mylfg 开始，在 lfg task 上运行；
// 不保留评测类型的 myreview 不能发起 run
const { db, close } = openTestDb();
const work = path.join(config.repoRoot, '.work', 'test-prepare', randomUUID());
const vaultDir = path.join(work, 'vault');
// 真实构建的 variant；wf runtime 与 cargo 缓存在 .work/test-data，跨测试运行复用
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
  vaultDir,
  product: config.evalProduct,
  runsDir: path.join(work, 'runs'),
  repos,
});
const created: string[] = [];

afterAll(async () => {
  await runsModule.shutdown();
  for (const id of created) fs.rmSync(variants.layout(id).dir, { recursive: true, force: true });
  close();
  fs.rmSync(work, { recursive: true, force: true });
});

function insertRun(taskId: string, variantId: string, prefix: string) {
  const id = testRunId(prefix);
  db.insert(batches)
    .values({ id: `b-${id}`, repeats: 1 })
    .run();
  db.insert(runs)
    .values({
      id,
      batchId: `b-${id}`,
      taskId,
      variantId,
      repeatIndex: 0,
      model: 'sonnet',
      effort: 'low',
      sessionId: randomUUID(),
      workspacePath: path.join(work, 'runs', id, 'workspace'),
    })
    .run();
  const row = db.select().from(runs).where(eq(runs.id, id)).get();
  if (row === undefined) throw new Error(`run ${id} 不存在`);
  return row;
}

describe('按评测类型准备与生成初始消息', { timeout: 900_000 }, () => {
  test('内置 lfg、复制出的 mylfg（保留评测类型）与 myreview（不保留）', async () => {
    syncTasks(db, config.tasksDir);
    const base = await variants.createBaseline({ name: `W41 基线 ${randomUUID().slice(0, 8)}` });
    created.push(base.id);
    await variants.build(base.id);
    const workflows = createWorkflows({ db, variants });
    const vault = { vaultDir, product: config.evalProduct };
    const signal = new AbortController().signal;

    // 内置 lfg：初始消息与原来写死的格式逐字相同
    const lfgRun = insertRun('lfg-calculator', base.id, 'w41-lfg');
    const lfgStage = evalSpecOf(db, 'lfg');
    const lfgInitial = await prepareRun({
      db,
      repos,
      ...vault,
      run: lfgRun,
      task: loadTask(db, 'lfg-calculator'),
      stage: lfgStage,
      signal,
    });
    const lfgRepo = path.join(String(repos.localDir), `wfe-${lfgRun.id}.git`);
    expect(lfgInitial).toBe(
      [
        '/lfg 做一个计算器',
        '',
        `Product: ${config.evalProduct}`,
        `Feature slug: ${lfgRun.id}`,
        `Repository: ${lfgRepo}`,
      ].join('\n'),
    );
    expect(db.select().from(runs).where(eq(runs.id, lfgRun.id)).get()?.githubRepo).toBe(lfgRepo);
    expect(fs.existsSync(path.join(lfgRun.workspacePath, '.git'))).toBe(true);
    expect(fs.existsSync(path.join(vaultDir, `Project ${config.evalProduct}`))).toBe(true);
    const lfgLaunch = launchSpec(variants.runtimeEnv(base.id), lfgRun, lfgStage, vault);
    expect(lfgLaunch.variantArgs).toEqual([
      '--model',
      'sonnet',
      '--effort',
      'low',
      '--mcp-config',
      variants.runtimeEnv(base.id).mcpConfigPath,
    ]);
    expect(lfgLaunch.env).toMatchObject({
      CLAUDE_CODE_PROJECT_DIR_NAME: lfgRun.id,
      MAGI_VAULT: vaultDir,
      MAGI_PRODUCT: config.evalProduct,
      CLAUDE_CONFIG_DIR: variants.runtimeEnv(base.id).env.CLAUDE_CONFIG_DIR,
    });

    // mylfg：复制 lfg 的定义、保留评测类型；第一个 variant 的入口 skill 改名为 mylfg
    const mylfg = workflows.create({
      id: 'mylfg',
      name: '我的 lfg',
      fromVariantId: base.id,
      keepEvalKind: true,
      definition: { ...loadWorkflow(db, 'lfg'), id: 'mylfg', name: '我的 lfg' },
    });
    expect(mylfg).toMatchObject({ evalKind: 'lfg', copiedFrom: 'lfg', variants: 1 });
    const mylfgVariant = variants.list().find((v) => v.workflowId === 'mylfg');
    if (mylfgVariant === undefined) throw new Error('mylfg 没有 variant');
    created.push(mylfgVariant.id);
    expect(mylfgVariant.name).toBe('基线');
    const skills = variants.layout(mylfgVariant.id).skills;
    expect(fs.existsSync(path.join(skills, 'mylfg', 'SKILL.md'))).toBe(true);
    expect(fs.existsSync(path.join(skills, 'lfg'))).toBe(false);
    expect(fs.readFileSync(path.join(skills, 'mylfg', 'SKILL.md'), 'utf8')).toMatch(/^name: mylfg$/m);
    await variants.build(mylfgVariant.id);
    const mylfgRun = insertRun('lfg-calculator', mylfgVariant.id, 'w41-mylfg');
    const mylfgStage = evalSpecOf(db, 'mylfg');
    const mylfgInitial = await prepareRun({
      db,
      repos,
      ...vault,
      run: mylfgRun,
      task: loadTask(db, 'lfg-calculator'),
      stage: mylfgStage,
      signal,
    });
    const mylfgRepo = path.join(String(repos.localDir), `wfe-${mylfgRun.id}.git`);
    expect(mylfgInitial).toBe(
      `/mylfg 做一个计算器\n\nProduct: Magi Eval\nFeature slug: ${mylfgRun.id}\nRepository: ${mylfgRepo}`,
    );
    const repoArtifact = db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.runId, mylfgRun.id), eq(artifacts.kind, 'repo')))
      .get();
    expect(repoArtifact?.location).toBe(`file://${mylfgRepo}`);
    const mylfgLaunch = launchSpec(
      variants.runtimeEnv(mylfgVariant.id),
      mylfgRun,
      mylfgStage,
      vault,
    );
    expect(mylfgLaunch.variantArgs.slice(0, 4)).toEqual(['--model', 'sonnet', '--effort', 'low']);
    expect(mylfgLaunch.env.MAGI_PRODUCT).toBe(config.evalProduct);

    // myreview：不保留评测类型，不能评测
    workflows.create({
      id: 'myreview',
      name: '我的 review',
      fromVariantId: base.id,
      keepEvalKind: false,
      definition: { ...loadWorkflow(db, 'lfg'), id: 'myreview', name: '我的 review' },
    });
    const myreviewVariant = variants.list().find((v) => v.workflowId === 'myreview');
    if (myreviewVariant === undefined) throw new Error('myreview 没有 variant');
    created.push(myreviewVariant.id);
    expect(() =>
      runsModule.createBatch({
        variantIds: [myreviewVariant.id],
        taskIds: ['lfg-calculator'],
        repeats: 1,
        model: 'opus',
        effort: 'high',
      }),
    ).toThrow('workflow myreview 没有评测类型，不能评测（只用于 Live、阶段划分与分析）');

    // ic 要 PR 评分：本地仓库模式下准备以原文失败，不建仓库
    const icRun = insertRun('lfg-calculator', base.id, 'w41-ic');
    await expect(
      prepareRun({
        db,
        repos,
        ...vault,
        run: icRun,
        task: loadTask(db, 'lfg-calculator'),
        stage: evalSpecOf(db, 'ic'),
        signal,
      }),
    ).rejects.toThrow(
      `本地仓库模式（${String(repos.localDir)}）下不能发起 /ic run：本地仓库没有 PR，不支持 PR 的评分（hidden-tests、criteria-judge、pr-endpoint）`,
    );
  });
});
