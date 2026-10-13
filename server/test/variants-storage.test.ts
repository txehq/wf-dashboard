import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { openTargetDir } from '../src/api/open.js';
import { buildApp } from '../src/api/app.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { variants as variantsTable } from '../src/db/schema.js';
import { createLive } from '../src/live/index.js';
import { createSettingsStore } from '../src/runs/settings.js';
import { createVariants } from '../src/variants/index.js';
import { testCodex } from './helpers/codex.js';
import { testRepos } from './helpers/local-repos.js';

// Contracts 16.4：迁移拆出的两个 variant 共用目录，其中一个被编辑时复制出自己的一份；skill 目录的新增、重命名与删除。
// 16.7："在访达中打开"只接受 dashboard 已知的目录
// 测试进程的数据目录（.work/test-data/<进程号>），与 buildApp 中的 variants 模块相同；结束时删除这里建出的 variant 目录
const dataDir = config.dataDir;
const work = path.join(config.repoRoot, '.work', 'test-variants-storage', randomUUID());
const db = openDatabase(path.join(work, 'db.sqlite'), config.migrationsDir);
const variants = createVariants({
  db,
  dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});
const app = await buildApp({
  db,
  sseHeartbeatMs: config.sseHeartbeatMs,
  logger: false,
  tasksDir: config.tasksDir,
});

beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
  const dirs = variants.list().map((v) => variants.layout(v.id).dir);
  db.$client.close();
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

// 与迁移相同地拆出一个共用 source 目录的 ic variant
let shared = 0;
function shareWith(sourceId: string): string {
  const source = variants.get(sourceId);
  const id = randomUUID();
  shared += 1;
  db.insert(variantsTable)
    .values({
      ...source,
      id,
      name: `${source.name} ${String(shared)}`,
      workflowId: 'ic',
      storageId: source.storageId ?? source.id,
    })
    .run();
  return id;
}

const read = (id: string, file: string) => variants.readFile(id, file);

describe('共用目录与复制出自己的一份', () => {
  test('共用的 variant 读到同一份内容；编辑其中一个时复制出自己的 src，另一个不变', async () => {
    const base = await variants.createBaseline({ name: '基线' });
    const icCopy = shareWith(base.id);
    const file = 'skills/interview/SKILL.md';
    const original = read(base.id, file);
    expect(read(icCopy, file)).toBe(original);
    expect(variants.layout(icCopy).dir).toBe(variants.layout(base.id).dir);

    const edited = variants.writeFile(icCopy, file, `${original}\n追加一行\n`);
    expect(edited.storageId).toBeNull();
    expect(edited.installDir).toBe(path.join(dataDir, 'variants', icCopy));
    expect(edited.buildStatus).toBe('none');
    expect(read(icCopy, file)).toBe(`${original}\n追加一行\n`);
    expect(read(base.id, file)).toBe(original);
    expect(variants.buildLog(icCopy)).toContain(`不再与 ${base.id} 共用目录`);

    // 目录属于 base 自己时，被编辑的 base 另取一个目录，共用它的 variant 留在原来的目录
    const second = shareWith(base.id);
    const before = variants.layout(base.id).dir;
    const moved = variants.writeFile(base.id, file, 'base 改过\n');
    expect(moved.storageId).not.toBeNull();
    expect(variants.layout(base.id).dir).not.toBe(before);
    expect(variants.layout(second).dir).toBe(before);
    expect(read(second, file)).toBe(original);
    expect(read(base.id, file)).toBe('base 改过\n');
  });

  test('skill 目录的新增、重命名与删除；名字不合规定 400、已存在 409、不存在 404', async () => {
    const v = await variants.createBaseline({ name: 'skill 目录' });
    const call = (method: 'POST' | 'PATCH' | 'DELETE', url: string, payload?: object) =>
      payload === undefined ? app.inject({ method, url }) : app.inject({ method, url, payload });

    const added = await call('POST', `/api/variants/${v.id}/skills`, { name: 'scan' });
    expect(added.statusCode).toBe(200);
    expect(read(v.id, 'skills/scan/SKILL.md')).toBe('---\nname: scan\ndescription: scan\n---\n');
    expect((await call('POST', `/api/variants/${v.id}/skills`, { name: 'scan' })).statusCode).toBe(
      409,
    );
    const bad = await call('POST', `/api/variants/${v.id}/skills`, { name: '../x' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ message: string }>().message).toBe(
      'skill 名只能包含小写字母、数字与连字符，以字母开头：../x',
    );

    // 重命名：frontmatter 的 name 随之改变，其余内容不变
    variants.writeFile(
      v.id,
      'skills/scan/SKILL.md',
      '---\nname: scan\n# 注释\ndescription: 扫描\n---\n正文\n',
    );
    const renamed = await call('PATCH', `/api/variants/${v.id}/skills/scan`, { name: 'review' });
    expect(renamed.statusCode).toBe(200);
    expect(read(v.id, 'skills/review/SKILL.md')).toBe(
      '---\nname: review\n# 注释\ndescription: 扫描\n---\n正文\n',
    );
    expect(variants.listFiles(v.id).some((f) => f.path.startsWith('skills/scan/'))).toBe(false);
    expect(
      (await call('PATCH', `/api/variants/${v.id}/skills/review`, { name: 'interview' }))
        .statusCode,
    ).toBe(409);

    const removed = await call('DELETE', `/api/variants/${v.id}/skills/review`);
    expect(removed.statusCode).toBe(200);
    expect(variants.listFiles(v.id).some((f) => f.path.startsWith('skills/review/'))).toBe(false);
    expect((await call('DELETE', `/api/variants/${v.id}/skills/review`)).statusCode).toBe(404);
  });
});

describe('在访达中打开', () => {
  const live = createLive({
    db,
    variants,
    settings: createSettingsStore(db),
    vaultDir: path.join(dataDir, 'vault'),
    product: config.evalProduct,
    liveDir: path.join(dataDir, 'live'),
    dataDir,
    serverUrl: () => 'http://127.0.0.1:1',
    localHome: path.join(dataDir, 'home'),
    repos: testRepos(),
    codex: testCodex(),
    claudeBin: config.claudeBin,
  });

  test('variant 的整个目录；目录不存在与不认识的目标 404；不接受任意路径', async () => {
    const v = await variants.createBaseline({ name: '打开' });
    expect(openTargetDir({ kind: 'variant', id: v.id }, { db, variants, live })).toBe(
      path.join(dataDir, 'variants', v.id),
    );
    expect(() =>
      openTargetDir({ kind: 'live-cwd', id: 'l-20261013-nopeno' }, { db, variants, live }),
    ).toThrow('交互不存在：l-20261013-nopeno');
    fs.rmSync(variants.layout(v.id).dir, { recursive: true });
    expect(() => openTargetDir({ kind: 'variant', id: v.id }, { db, variants, live })).toThrow(
      `目录不存在：${path.join(dataDir, 'variants', v.id)}`,
    );
    db.update(variantsTable).set({ installDir: null }).where(eq(variantsTable.id, v.id)).run();
    const missing = await app.inject({
      method: 'POST',
      url: '/api/open',
      payload: { target: { kind: 'variant', id: v.id } },
    });
    expect(missing.statusCode).toBe(404);
    const anyPath = await app.inject({
      method: 'POST',
      url: '/api/open',
      payload: { target: { kind: 'path', path: '/etc' } },
    });
    expect(anyPath.statusCode).toBe(400);
  });
});
