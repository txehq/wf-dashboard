import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { openDatabase } from '../../src/db/index.js';
import { createDrafts } from '../../src/drafts/index.js';
import type { CreateDraftBody, DraftView } from '../../src/drafts/views.js';
import { createLive } from '../../src/live/index.js';
import { createSettingsStore } from '../../src/runs/settings.js';
import { createVariants, type Variant } from '../../src/variants/index.js';
import { testCodex } from '../helpers/codex.js';
import { makeSkillSources } from '../helpers/codex-skills.js';
import { testRepos } from '../helpers/local-repos.js';

// 慢档（Contracts 17.4）：lfg、ic 之下"用 Codex 生成 variant"的保存仍是 txe-workflow 导出与 wf 构建。
// 测试代码直接改草稿中的 skill 后保存，不需要 Codex；wf runtime 与 cargo 缓存在 .work/test-data，跨测试运行复用。
// 从空白开始的新 workflow 草稿用自有管理器构建，见 drafts-blank.test.ts（基础档）
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
  claudeBin: config.claudeBin,
});
const drafts = createDrafts({
  db,
  variants,
  live,
  draftsDir: config.workflowDraftsDir,
  dataDir: variantsData,
  skillSources: makeSkillSources(path.join(config.dataDir, 'skill-sources')),
});
const marker = randomUUID().slice(0, 6);
const created: Variant[] = [];

afterAll(async () => {
  // 准备的最后一步启动的 Codex 替身
  await live.shutdown();
  db.$client.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  for (const v of created) {
    fs.rmSync(path.join(variantsData, 'variants', v.id), { recursive: true, force: true });
  }
});

// 发起并等准备完成（skill 来源是本地 git 仓库，Codex 是替身命令）
async function openReady(body: CreateDraftBody): Promise<DraftView> {
  const { draft } = drafts.open(body);
  await drafts.prepare(draft.id);
  const ready = drafts.get(draft.id);
  expect(ready.status, ready.error ?? '').toBe('open');
  return ready;
}

describe('保存 lfg 的 Codex 草稿：真实的 wf 构建', { timeout: 1_800_000 }, () => {
  test('mode variant：src 是底子的 txe-workflow 导出，在 lfg 下建新 variant，parent 为底子，wf status 0 退出', async () => {
    const base = await variants.createBaseline({ name: `草稿底子 ${marker}` });
    created.push(base);
    const draft = await openReady({
      mode: 'variant',
      workflowId: 'lfg',
      requirement: '让 interview 先说明目的',
      baseVariantId: base.id,
    });
    // lfg 的草稿说明是 wf 的那一份
    expect(fs.readFileSync(path.join(draft.dir, 'PLATFORM.md'), 'utf8')).toContain('wf guard');
    expect(fs.existsSync(path.join(draft.dir, 'src/workflow/registry.yaml'))).toBe(true);
    fs.appendFileSync(
      path.join(draft.dir, 'src/skills/interview/SKILL.md'),
      '\n先说明这次访谈的目的。\n',
    );
    const saved = await drafts.save(draft.id);
    const v = variants.get(saved.savedVariantId ?? '');
    created.push(v);
    expect([v.buildStatus, v.builtHash]).toEqual(['built', v.skillsHash]);
    expect(variants.buildLog(v.id)).toMatch(/\[status\] exit 0,/);
    expect(v.name).toBe(`Codex ${draft.id}`);
    expect(v.workflowId).toBe('lfg');
    expect(v.parentId).toBe(base.id);
    expect(v.draftId).toBe(draft.id);
    expect(variants.diff(v.id, 'parent').files.map((f) => f.path)).toEqual([
      'skills/interview/SKILL.md',
    ]);
  });
});
