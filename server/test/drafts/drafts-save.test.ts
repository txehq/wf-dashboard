import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { stringify } from 'yaml';
import { config } from '../../src/config.js';
import { openDatabase } from '../../src/db/index.js';
import { createDrafts } from '../../src/drafts/index.js';
import { createLive } from '../../src/live/index.js';
import { createSettingsStore } from '../../src/runs/settings.js';
import { createVariants, type Variant } from '../../src/variants/index.js';
import { loadWorkflow, workflowRow } from '../../src/workflows/index.js';
import { testCodex } from '../helpers/codex.js';
import { testRepos } from '../helpers/local-repos.js';

// 慢档（Contracts 17.4）：保存时的真实构建。测试代码直接写出 skill 文件（例子 workflow 的 skill）后保存，
// 不需要 Codex；wf runtime 与 cargo 缓存在 .work/test-data，跨测试运行复用（与 variants.test.ts 相同）
const variantsData = path.join(config.repoRoot, '.work', 'test-data');
const dbFile = path.join(config.repoRoot, '.work', 'test-db', `${randomUUID()}.sqlite`);
const db = openDatabase(dbFile, config.migrationsDir);
const variants = createVariants({
  db,
  dataDir: variantsData,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});
const live = createLive({
  db,
  variants,
  settings: createSettingsStore(db),
  vaultDir: config.vaultDir,
  product: config.evalProduct,
  liveDir: config.liveDir,
  dataDir: variantsData,
  serverUrl: () => 'http://127.0.0.1:1',
  localHome: path.join(config.dataDir, 'home'),
  repos: testRepos(),
  codex: testCodex(),
});
const drafts = createDrafts({
  db,
  variants,
  live,
  draftsDir: config.workflowDraftsDir,
  skillSources: config.codexSkillSources,
});
const marker = randomUUID().slice(0, 6);
const created: Variant[] = [];
const example = path.join(config.repoRoot, 'server/src/drafts/assets/simple-workflow');

afterAll(() => {
  db.$client.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  for (const v of created) {
    fs.rmSync(path.join(variantsData, 'variants', v.id), { recursive: true, force: true });
  }
});

// 例子 workflow 的四个 skill 写进草稿的 src/skills/，workflow.yaml 换成例子的定义（id 改为 workflowId）
function writeExample(dir: string, workflowId: string) {
  const skills = path.join(dir, 'src/skills');
  for (const name of fs.readdirSync(path.join(example, 'skills'))) {
    const target = name === 'hello-flow' ? workflowId : name;
    fs.mkdirSync(path.join(skills, target), { recursive: true });
    fs.writeFileSync(
      path.join(skills, target, 'SKILL.md'),
      fs
        .readFileSync(path.join(example, 'skills', name, 'SKILL.md'), 'utf8')
        .replace('name: hello-flow', `name: ${workflowId}`),
    );
  }
  fs.writeFileSync(
    path.join(dir, 'workflow.yaml'),
    stringify({
      id: workflowId,
      name: `你好 ${marker}`,
      stages: [{ id: 'gather' }, { id: 'draft' }, { id: 'review', repeatable: true }],
    }),
  );
}

function built(id: string): Variant {
  const v = variants.get(id);
  created.push(v);
  expect(v.buildStatus).toBe('built');
  expect(v.builtHash).toBe(v.skillsHash);
  // 构建的最后一步是 wf status，0 退出
  expect(variants.buildLog(id)).toMatch(/\[status\] exit 0,/);
  return v;
}

describe('保存 Codex 草稿：真实构建', { timeout: 1_800_000 }, () => {
  let base: Variant;
  const workflowId = `hello-${marker}`;

  test('mode workflow：建 workflow 与它的第一个 variant「基线」，再次保存建出新 variant', async () => {
    base = await variants.createBaseline({ name: `草稿底子 ${marker}` });
    created.push(base);
    const draft = drafts.open({
      mode: 'workflow',
      workflowId,
      name: `你好 ${marker}`,
      requirement: '做一个打招呼的 workflow',
      baseVariantId: base.id,
    });
    writeExample(draft.dir, workflowId);

    const saved = await drafts.save(draft.id);
    expect(saved.status).toBe('saved');
    expect(saved.savedWorkflowId).toBe(workflowId);
    const workflow = workflowRow(db, workflowId);
    expect(workflow.evalKind).toBeNull();
    expect(workflow.copiedFrom).toBe('lfg');
    expect(loadWorkflow(db, workflowId).stages.map((s) => s.id)).toEqual([
      'gather',
      'draft',
      'review',
    ]);
    expect(saved.savedVariants.map((v) => v.name)).toEqual(['基线']);
    const first = built(saved.savedVariants[0]?.id ?? '');
    expect(first.workflowId).toBe(workflowId);
    expect(first.parentId).toBe(base.id);
    expect(first.draftId).toBe(draft.id);
    expect(saved.savedVariantId).toBe(first.id);
    // 自动登记了新 skill，variant 的 src/ 取草稿的 src/
    expect(variants.buildLog(first.id)).toMatch(
      new RegExp(`\\[register-skills\\] 登记 [^；\\n]*${workflowId}`),
    );
    expect(
      fs.readFileSync(path.join(variants.layout(first.id).skills, 'gather/SKILL.md'), 'utf8'),
    ).toBe(fs.readFileSync(path.join(draft.dir, 'src/skills/gather/SKILL.md'), 'utf8'));

    const again = await drafts.save(draft.id);
    expect(again.savedVariants.map((v) => v.name)).toEqual(['基线', `Codex ${draft.id}`]);
    const second = built(again.savedVariantId ?? '');
    expect(second.name).toBe(`Codex ${draft.id}`);
    expect(second.workflowId).toBe(workflowId);
    expect(second.draftId).toBe(draft.id);

    // workflow.yaml 改了定义：以原文失败，不建 variant
    fs.appendFileSync(path.join(draft.dir, 'workflow.yaml'), '  - id: publish\n');
    await expect(drafts.save(draft.id)).rejects.toThrow(
      `workflow.yaml 与已保存的 workflow ${workflowId} 的定义不同`,
    );
    expect(drafts.get(draft.id).savedVariants).toHaveLength(2);
  });

  test('mode variant：在所属 workflow 下建新 variant，parent 为底子', async () => {
    const draft = drafts.open({
      mode: 'variant',
      workflowId: 'lfg',
      requirement: '让 interview 先说明目的',
      baseVariantId: base.id,
    });
    fs.appendFileSync(
      path.join(draft.dir, 'src/skills/interview/SKILL.md'),
      '\n先说明这次访谈的目的。\n',
    );
    const saved = await drafts.save(draft.id);
    const v = built(saved.savedVariantId ?? '');
    expect(v.name).toBe(`Codex ${draft.id}`);
    expect(v.workflowId).toBe('lfg');
    expect(v.parentId).toBe(base.id);
    expect(v.draftId).toBe(draft.id);
    expect(variants.diff(v.id, 'parent').files.map((f) => f.path)).toEqual([
      'skills/interview/SKILL.md',
    ]);
  });

  test('构建失败：以构建日志的原文失败，这次建出的 workflow 与 variant 删去，草稿保留', async () => {
    const brokenId = `broken-${marker}`;
    const draft = drafts.open({
      mode: 'workflow',
      workflowId: brokenId,
      name: `坏的 ${marker}`,
      requirement: 'x',
      baseVariantId: base.id,
    });
    writeExample(draft.dir, brokenId);
    // wf guard 读不了的 registry
    fs.writeFileSync(path.join(draft.dir, 'src/workflow/registry.yaml'), 'components: [\n');
    const before = variants.list().length;
    await expect(drafts.save(draft.id)).rejects.toThrow(/构建失败：/);
    expect(variants.list()).toHaveLength(before);
    expect(() => workflowRow(db, brokenId)).toThrow(`没有 workflow ${brokenId}`);
    const after = drafts.get(draft.id);
    expect(after.status).toBe('open');
    expect(after.savedVariants).toEqual([]);
    expect(fs.existsSync(path.join(draft.dir, 'src/skills/gather/SKILL.md'))).toBe(true);
  });
});
