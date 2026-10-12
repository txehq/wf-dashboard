import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { parse, stringify } from 'yaml';
import { config } from '../../src/config.js';
import { artifacts, batches, runs } from '../../src/db/schema.js';
import { launchSpec, prepareRun } from '../../src/runs/prepare.js';
import { loadTask, syncTasks } from '../../src/tasks/loader.js';
import { createVariants } from '../../src/variants/index.js';
import { createWorkflows, loadBigStage } from '../../src/workflows/index.js';
import { testRunId } from '../helpers/ic-fixture.js';
import { testRepos } from '../helpers/local-repos.js';
import { openTestDb } from '../stages/db.js';

// Contracts 16.2：准备、初始消息与启动 claude 的参数按大阶段的积木生成；只测到启动 claude 之前。
// dev-workflow 的 lfg 生成的初始消息与环境与改为积木之前的写法相同（runner 中原来的 lfg 分支）
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
const created: string[] = [];

afterAll(() => {
  for (const id of created) fs.rmSync(variants.layout(id).dir, { recursive: true, force: true });
  close();
  fs.rmSync(work, { recursive: true, force: true });
});

// next-workflow 的 newlfg task（字段由积木推出：input、persona、hiddenRequirements、rubric）与 dev-workflow 的 lfg-calculator
function writeTasks(): string {
  const dir = path.join(work, 'tasks');
  fs.cpSync(path.join(config.tasksDir, 'lfg-calculator'), path.join(dir, 'lfg-calculator'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(dir, 'next-calculator'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'next-calculator', 'task.yaml'),
    stringify({
      id: 'next-calculator',
      workflow: 'next-workflow',
      bigStage: 'newlfg',
      title: '计算器',
      persona: '一位数学老师',
      hiddenRequirements: '四则运算',
      input: '做一个计算器',
      rubric: [
        { artifact: 'scope', items: [{ id: 's1', criterion: '写出范围', maxScore: 2 }] },
        { artifact: 'tickets', items: [{ id: 't1', criterion: '拆出工单', maxScore: 2 }] },
      ],
    }),
  );
  return dir;
}

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

describe('按积木准备与生成初始消息', { timeout: 900_000 }, () => {
  test('dev-workflow 的 lfg 与 next-workflow 的 newlfg（prepare: [empty-repo, vault-dir]）', async () => {
    const base = await variants.createBaseline({ name: `W36 基线 ${randomUUID().slice(0, 8)}` });
    created.push(base.id);
    await variants.build(base.id);
    const workflows = createWorkflows({ db, variants });
    const nextYaml = fs.readFileSync(
      path.join(import.meta.dirname, '../fixtures/workflows/next-workflow.yaml'),
      'utf8',
    );
    const view = workflows.create({
      id: 'next-workflow',
      name: 'next-workflow',
      variantId: base.id,
      definition: parse(nextYaml),
    });
    if (view.baseVariantId === null) throw new Error('next-workflow 没有底子');
    const next = view.baseVariantId;
    created.push(next);
    // 新 workflow 的入口与小阶段的 skill
    for (const skill of [
      'newlfg',
      'scope',
      'spike',
      'tickets',
      'newic',
      'build',
      'ship',
      'polish',
    ]) {
      variants.writeFile(
        next,
        `skills/${skill}/SKILL.md`,
        `---\nname: ${skill}\ndescription: next-workflow 的 ${skill} 阶段\n---\n\n# ${skill}\n`,
      );
    }
    await variants.build(next);
    syncTasks(db, writeTasks());

    const vault = { vaultDir, product: config.evalProduct };
    const signal = new AbortController().signal;

    // dev-workflow 的 lfg：初始消息与原来写死的格式逐字相同
    const lfgRun = insertRun('lfg-calculator', base.id, 'w36-lfg');
    const lfgStage = loadBigStage(db, 'dev-workflow', 'lfg');
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

    // next-workflow 的 newlfg：按模板生成
    const nextRun = insertRun('next-calculator', next, 'w36-next');
    const nextStage = loadBigStage(db, 'next-workflow', 'newlfg');
    const nextInitial = await prepareRun({
      db,
      repos,
      ...vault,
      run: nextRun,
      task: loadTask(db, 'next-calculator'),
      stage: nextStage,
      signal,
    });
    const nextRepo = path.join(String(repos.localDir), `wfe-${nextRun.id}.git`);
    expect(nextInitial).toBe(
      `/newlfg 做一个计算器\n\nProduct: Magi Eval\nFeature slug: ${nextRun.id}\nRepository: ${nextRepo}`,
    );
    const repoArtifact = db
      .select()
      .from(artifacts)
      .where(and(eq(artifacts.runId, nextRun.id), eq(artifacts.kind, 'repo')))
      .get();
    expect(repoArtifact?.location).toBe(`file://${nextRepo}`);
    const nextLaunch = launchSpec(variants.runtimeEnv(next), nextRun, nextStage, vault);
    expect(nextLaunch.variantArgs.slice(0, 4)).toEqual(['--model', 'sonnet', '--effort', 'low']);
    expect(nextLaunch.env.MAGI_PRODUCT).toBe(config.evalProduct);
    expect(nextLaunch.env.CLAUDE_CONFIG_DIR).toBe(variants.runtimeEnv(next).env.CLAUDE_CONFIG_DIR);

    // dev-workflow 的 ic 要 PR 评分：本地仓库模式下准备以原文失败，不建仓库
    const icRun = insertRun('lfg-calculator', base.id, 'w36-ic');
    await expect(
      prepareRun({
        db,
        repos,
        ...vault,
        run: icRun,
        task: loadTask(db, 'lfg-calculator'),
        stage: loadBigStage(db, 'dev-workflow', 'ic'),
        signal,
      }),
    ).rejects.toThrow(
      `本地仓库模式（${String(repos.localDir)}）下不能发起 /ic run：本地仓库没有 PR，不支持 PR 的评分（hidden-tests、criteria-judge、pr-endpoint）`,
    );
  });
});
