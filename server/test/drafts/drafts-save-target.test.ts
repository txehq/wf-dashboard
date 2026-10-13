import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { codexStandIn, makeSkillSources } from '../helpers/codex-skills.js';

// 基础档（Contracts 17.4）：Codex 草稿保存时新建 variant 或覆盖同一 workflow 中的 variant，名字与描述必填，不构建；
// 覆盖前原来的 src/ 进 variant 的历史，可以查看与恢复；导入的与已冻结的不能覆盖。
// 测试代码直接写出草稿中的 skill 后保存，不调用 Codex（Codex 是替身命令），skill 来源是 .work/ 下的本地 git 仓库
const work = path.resolve(import.meta.dirname, '../../../.work/test-drafts', randomUUID());
const sources = makeSkillSources(path.join(work, 'skill-sources'));
process.env.WFD_CODEX_SKILL_SOURCES = JSON.stringify(sources);
process.env.WFD_CODEX_BIN = codexStandIn;

const { buildApp } = await import('../../src/api/app.js');
const { config } = await import('../../src/config.js');
const { openDatabase } = await import('../../src/db/index.js');
const { variants: variantsTable } = await import('../../src/db/schema.js');
const { createVariants } = await import('../../src/variants/index.js');

const dbFile = path.join(config.repoRoot, '.work', 'test-db', `${randomUUID()}.sqlite`);
const db = openDatabase(dbFile, config.migrationsDir);
const app = await buildApp({
  db,
  sseHeartbeatMs: config.sseHeartbeatMs,
  logger: false,
  tasksDir: config.tasksDir,
});
// 冻结是 runs 首次运行 variant 时做的；这里用同一数据库与数据目录上的 variants 模块直接冻结
const variants = createVariants({
  db,
  dataDir: config.dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});
const marker = randomUUID().slice(0, 6);
const flowId = `save-${marker}`;

interface Draft {
  id: string;
  status: string;
  error: string | null;
  steps: { status: string }[];
  liveId: string | null;
  dir: string;
  savedWorkflowId: string | null;
  savedVariantId: string | null;
}
interface Variant {
  id: string;
  name: string;
  description: string | null;
  workflowId: string;
  parentId: string | null;
  status: string;
  buildStatus: string;
  builtHash: string | null;
  draftId: string | null;
  installDir: string;
}
interface FileDiff {
  path: string;
  status: string;
  oldContent: string;
  newContent: string;
}
type HistoryEntry = { id: number; kind: string } & Record<string, unknown>;

const skillMd = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: ${name} 阶段\n---\n\n${body}\n`;

const get = async <T>(url: string) => {
  const response = await app.inject({ method: 'GET', url });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
};
const getVariant = (id: string) => get<Variant>(`/api/variants/${id}`);
const save = (id: string, target: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: `/api/workflow-drafts/${id}/save`, payload: { target } });

const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

// 发起 mode variant 的草稿并等准备完成
async function openDraft(baseVariantId: string): Promise<Draft> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/workflow-drafts',
    payload: { mode: 'variant', workflowId: flowId, requirement: '改 scan', baseVariantId },
  });
  expect(created.statusCode, created.body).toBe(201);
  const { draft } = created.json<{ draft: Draft }>();
  for (;;) {
    const d = await get<Draft>(`/api/workflow-drafts/${draft.id}`);
    if (d.status === 'failed') throw new Error(d.error ?? '准备失败');
    if (d.steps.every((s) => s.status === 'done')) return d;
    await sleep(100);
  }
}

const writeScan = (draft: Draft, body: string) => {
  fs.writeFileSync(path.join(draft.dir, 'src/skills/scan/SKILL.md'), skillMd('scan', body));
};
const readScan = (v: Variant) =>
  fs.readFileSync(path.join(v.installDir, 'src/skills/scan/SKILL.md'), 'utf8');

let first: Variant;
let draft: Draft;

beforeAll(async () => {
  await app.ready();
  // 从空白新建的 workflow 与它的第一个 variant「初稿」（Contracts 18.5）
  const created = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    payload: {
      id: flowId,
      name: `保存 ${marker}`,
      description: '',
      definition: { id: flowId, name: `保存 ${marker}`, stages: [{ id: 'scan' }] },
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  const initial = variants.list().find((v) => v.workflowId === flowId);
  if (initial === undefined) throw new Error(`workflow ${flowId} 没有建出初稿`);
  first = await getVariant(initial.id);
  draft = await openDraft(first.id);
});

afterAll(async () => {
  for (const id of [draft.liveId]) {
    if (id !== null) await app.inject({ method: 'POST', url: `/api/live/${id}/stop` });
  }
  await app.close();
  db.$client.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

describe('Codex 草稿的保存：新建或覆盖，不构建（基础档）', { timeout: 60_000 }, () => {
  let created: Variant;

  test('新建：名字或描述为空 400、同名 409；保存出的 variant 为 draft、未构建，src 为草稿的 src，记录来源草稿与 parent', async () => {
    writeScan(draft, '先列出要扫描的目录。');
    const plan = await get<{ kind: string; parent: unknown; variants: unknown[] }>(
      `/api/workflow-drafts/${draft.id}/save-plan`,
    );
    expect(plan).toEqual({
      kind: 'variant',
      workflowId: flowId,
      workflowName: `保存 ${marker}`,
      parent: { id: first.id, name: '初稿' },
      variants: [{ id: first.id, name: '初稿', description: null, reason: null }],
    });
    // 新建时的预览相对底子
    const preview = await get<{ base: unknown; files: FileDiff[] }>(
      `/api/workflow-drafts/${draft.id}/diff`,
    );
    expect(preview.base).toEqual({ id: first.id, name: '初稿' });
    expect(preview.files.map((f) => [f.path, f.status])).toEqual([
      ['skills/scan/SKILL.md', 'modified'],
    ]);

    for (const [target, status, error] of [
      [{ kind: 'new', name: '  ', description: '扫描' }, 400, 'variant 的名字不能为空'],
      [{ kind: 'new', name: '扫描', description: '' }, 400, 'variant 的描述不能为空'],
      [{ kind: 'new', name: 'x'.repeat(101), description: '扫描' }, 400, '最多 100 字'],
      [{ kind: 'new', name: '初稿', description: '扫描' }, 409, `名称已被使用：初稿 (${flowId})`],
    ] as const) {
      const rejected = await save(draft.id, target);
      expect(rejected.statusCode, rejected.body).toBe(status);
      expect(rejected.body).toContain(error);
    }
    expect(variants.list().filter((v) => v.workflowId === flowId)).toHaveLength(1);

    const response = await save(draft.id, {
      kind: 'new',
      name: ' 先列目录 ',
      description: '扫描前先列目录',
    });
    expect(response.statusCode, response.body).toBe(200);
    const saved = response.json<Draft>();
    expect(saved.status).toBe('saved');
    created = await getVariant(saved.savedVariantId ?? '');
    expect(created).toMatchObject({
      name: '先列目录',
      description: '扫描前先列目录',
      workflowId: flowId,
      parentId: first.id,
      draftId: draft.id,
      status: 'draft',
      buildStatus: 'none',
      builtHash: null,
    });
    expect(readScan(created)).toBe(skillMd('scan', '先列出要扫描的目录。'));
    // 没有构建产物：没有 variant.json，配置目录中没有装 skill
    expect(fs.existsSync(path.join(created.installDir, 'variant.json'))).toBe(false);
    expect(fs.existsSync(path.join(created.installDir, 'home/claude/skills'))).toBe(false);
  });

  test('覆盖：预览相对被覆盖的 variant；构建产物删去、状态为未构建，名字与描述更新，原来的 src 进历史并能恢复', async () => {
    // 先构建初稿，覆盖后构建产物应当删去
    const built = await app.inject({ method: 'POST', url: `/api/variants/${first.id}/build` });
    expect(built.statusCode, built.body).toBe(200);
    expect((await getVariant(first.id)).buildStatus).toBe('built');
    const before = readScan(first);

    writeScan(draft, '扫描完写一份清单。');
    const preview = await get<{ base: unknown; files: FileDiff[] }>(
      `/api/workflow-drafts/${draft.id}/diff?against=${first.id}`,
    );
    expect(preview.base).toEqual({ id: first.id, name: '初稿' });
    expect(preview.files.map((f) => [f.path, f.oldContent, f.newContent])).toEqual([
      ['skills/scan/SKILL.md', before, skillMd('scan', '扫描完写一份清单。')],
    ]);

    const empty = await save(draft.id, {
      kind: 'overwrite',
      variantId: first.id,
      name: '初稿',
      description: ' ',
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.body).toContain('variant 的描述不能为空');
    const sameName = await save(draft.id, {
      kind: 'overwrite',
      variantId: first.id,
      name: '先列目录',
      description: '清单',
    });
    expect(sameName.statusCode).toBe(409);
    expect(sameName.body).toContain(`名称已被使用：先列目录 (${flowId})`);
    expect(readScan(first)).toBe(before);

    const response = await save(draft.id, {
      kind: 'overwrite',
      variantId: first.id,
      name: '写清单',
      description: '扫描完写一份清单',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json<Draft>().savedVariantId).toBe(first.id);
    const overwritten = await getVariant(first.id);
    expect(overwritten).toMatchObject({
      name: '写清单',
      description: '扫描完写一份清单',
      parentId: null,
      draftId: draft.id,
      status: 'draft',
      buildStatus: 'none',
      builtHash: null,
    });
    expect(readScan(overwritten)).toBe(skillMd('scan', '扫描完写一份清单。'));
    expect(fs.existsSync(path.join(overwritten.installDir, 'variant.json'))).toBe(false);
    expect(fs.existsSync(path.join(overwritten.installDir, 'dist'))).toBe(false);

    // 历史：改名与覆盖；查看覆盖前的 src（现在的内容恢复成它时的改动）
    const history = await get<HistoryEntry[]>(`/api/variants/${first.id}/history`);
    expect(history.map((e) => e.kind)).toEqual(['rename', 'overwrite']);
    expect(history[0]).toMatchObject({ from: '初稿', to: '写清单' });
    const overwrite = history[1];
    if (overwrite === undefined) throw new Error('没有覆盖的记录');
    expect(overwrite).toMatchObject({ draftId: draft.id, analysisId: null });
    const old = await get<FileDiff[]>(
      `/api/variants/${first.id}/history/${String(overwrite.id)}/diff`,
    );
    expect(old.map((f) => [f.path, f.newContent])).toEqual([['skills/scan/SKILL.md', before]]);
    // 改名没有 src 可看
    const rename = await app.inject({
      method: 'GET',
      url: `/api/variants/${first.id}/history/${String(history[0]?.id)}/diff`,
    });
    expect(rename.statusCode).toBe(400);

    // 恢复：内容回到覆盖前，恢复前的内容同样进历史，再恢复一次回到覆盖后的内容
    const restored = await app.inject({
      method: 'POST',
      url: `/api/variants/${first.id}/history/${String(overwrite.id)}/restore`,
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(restored.json<Variant>()).toMatchObject({ buildStatus: 'none', builtHash: null });
    expect(readScan(overwritten)).toBe(before);
    const after = await get<HistoryEntry[]>(`/api/variants/${first.id}/history`);
    const restore = after.at(-1);
    expect(restore).toMatchObject({ kind: 'restore', restoredEventId: overwrite.id });
    const back = await app.inject({
      method: 'POST',
      url: `/api/variants/${first.id}/history/${String(restore?.id)}/restore`,
    });
    expect(back.statusCode, back.body).toBe(200);
    expect(readScan(overwritten)).toBe(skillMd('scan', '扫描完写一份清单。'));
  });

  test('已冻结与导入的 variant 不能覆盖：保存对话框中写明原因，保存 409 原文；其他 workflow 的 variant 400', async () => {
    // 冻结：构建通过后由 runs 冻结
    const built = await app.inject({ method: 'POST', url: `/api/variants/${created.id}/build` });
    expect(built.statusCode, built.body).toBe(200);
    variants.freeze(created.id);
    // 导入的 variant 只有 skill 内容，没有安装目录
    const derived = await app.inject({
      method: 'POST',
      url: `/api/variants/${first.id}/derive`,
      payload: { name: '导入的' },
    });
    expect(derived.statusCode, derived.body).toBe(201);
    const importedId = derived.json<Variant>().id;
    db.update(variantsTable)
      .set({ installDir: null })
      .where(eq(variantsTable.id, importedId))
      .run();

    const plan = await get<{ variants: { id: string; reason: string | null }[] }>(
      `/api/workflow-drafts/${draft.id}/save-plan`,
    );
    expect(Object.fromEntries(plan.variants.map((v) => [v.id, v.reason]))).toEqual({
      [first.id]: null,
      [created.id]: '已冻结（用于 batch），内容只读',
      [importedId]: '导入的 variant 只有 skill 内容，不能被覆盖',
    });
    for (const [variantId, error] of [
      [created.id, 'variant 先列目录：已冻结（用于 batch），内容只读'],
      [importedId, 'variant 导入的：导入的 variant 只有 skill 内容，不能被覆盖'],
    ] as const) {
      const rejected = await save(draft.id, {
        kind: 'overwrite',
        variantId,
        name: '覆盖',
        description: '覆盖',
      });
      expect(rejected.statusCode).toBe(409);
      expect(rejected.body).toContain(error);
    }
    const frozenRestore = await app.inject({
      method: 'POST',
      url: `/api/variants/${created.id}/history/1/restore`,
    });
    expect(frozenRestore.statusCode).toBe(409);

    // 另一个 workflow 的 variant
    const otherId = `save-other-${marker}`;
    const otherFlow = await app.inject({
      method: 'POST',
      url: '/api/workflows',
      payload: {
        id: otherId,
        name: `另一个 ${marker}`,
        description: '',
        definition: { id: otherId, name: `另一个 ${marker}`, stages: [{ id: 'scan' }] },
      },
    });
    expect(otherFlow.statusCode, otherFlow.body).toBe(201);
    const foreign = variants.list().find((v) => v.workflowId === otherId);
    if (foreign === undefined) throw new Error(`workflow ${otherId} 没有建出初稿`);
    const other = await save(draft.id, {
      kind: 'overwrite',
      variantId: foreign.id,
      name: '覆盖',
      description: '覆盖',
    });
    expect(other.statusCode).toBe(400);
    expect(other.body).toContain(`这个草稿保存到 ${flowId}，只能覆盖其中的 variant`);
  });
});
