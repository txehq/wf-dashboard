import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';

const dbFile = path.join(config.repoRoot, '.work', 'test-db', `${randomUUID()}.sqlite`);
const db = openDatabase(dbFile, config.migrationsDir);
const app = await buildApp({ db, sseHeartbeatMs: config.sseHeartbeatMs, logger: false });
const marker = randomUUID().slice(0, 8);
const createdIds: string[] = [];

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.$client.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  for (const id of createdIds) {
    fs.rmSync(path.join(config.variantsDir, id), { recursive: true, force: true });
  }
});

interface VariantBody {
  id: string;
  name: string;
  parentId: string | null;
  skillsHash: string;
  model: string;
  effort: string;
  buildStatus: string;
}

describe('variants API', () => {
  let base: VariantBody;
  let draft: VariantBody;

  test('模型与 effort 选项来自 gateway 别名', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/variants/options' });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ models: { alias: string; model: string }[]; efforts: string[] }>();
    expect(body.models.map((m) => m.alias)).toEqual(['opus', 'sonnet', 'haiku', 'fable']);
    for (const m of body.models) expect(m.model).toMatch(/^claude-/);
    expect(body.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });

  test('导入基线、派生、列表与详情', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/variants',
      payload: { name: `api 基线 ${marker}` },
    });
    expect(created.statusCode).toBe(201);
    base = created.json<VariantBody>();
    createdIds.push(base.id);
    expect(base.model).toBe('opus');
    expect(base.effort).toBe('high');

    const derived = await app.inject({
      method: 'POST',
      url: `/api/variants/${base.id}/derive`,
      payload: { name: `api 派生 ${marker}` },
    });
    expect(derived.statusCode).toBe(201);
    draft = derived.json<VariantBody>();
    createdIds.push(draft.id);
    expect(draft.parentId).toBe(base.id);

    const duplicate = await app.inject({
      method: 'POST',
      url: `/api/variants/${base.id}/derive`,
      payload: { name: `api 派生 ${marker}` },
    });
    expect(duplicate.statusCode).toBe(409);

    const list = (await app.inject({ method: 'GET', url: '/api/variants' })).json<VariantBody[]>();
    expect(list.map((v) => v.id)).toEqual(expect.arrayContaining([base.id, draft.id]));
    const detail = await app.inject({ method: 'GET', url: `/api/variants/${draft.id}` });
    expect(detail.json<VariantBody>().name).toBe(`api 派生 ${marker}`);
    expect((await app.inject({ method: 'GET', url: '/api/variants/nope' })).statusCode).toBe(404);
  });

  test('文件树、读写、diff 与设置', async () => {
    const files = (
      await app.inject({ method: 'GET', url: `/api/variants/${draft.id}/files` })
    ).json<{ path: string; size: number }[]>();
    expect(files.every((f) => f.path.startsWith('skills/'))).toBe(true);
    expect(files.map((f) => f.path)).toContain('skills/lfg/SKILL.md');

    const read = await app.inject({
      method: 'GET',
      url: `/api/variants/${draft.id}/file?path=skills/lfg/SKILL.md`,
    });
    const content = read.json<{ content: string }>().content;
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/variants/${draft.id}/file`,
      payload: { path: 'skills/lfg/SKILL.md', content: `${content}\nAPI ${marker}\n` },
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<VariantBody>().skillsHash).not.toBe(base.skillsHash);

    const diff = await app.inject({
      method: 'GET',
      url: `/api/variants/${draft.id}/diff?against=parent`,
    });
    const body = diff.json<{ files: { path: string; patch: string }[] }>();
    expect(body.files.map((f) => f.path)).toEqual(['skills/lfg/SKILL.md']);
    expect(body.files[0]?.patch).toContain(`+API ${marker}`);
    const baseDiff = await app.inject({ method: 'GET', url: `/api/variants/${base.id}/diff` });
    expect(baseDiff.json<{ files: unknown[] }>().files).toEqual([]);
    const noParent = await app.inject({
      method: 'GET',
      url: `/api/variants/${base.id}/diff?against=parent`,
    });
    expect(noParent.statusCode).toBe(400);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/variants/${draft.id}`,
      payload: { model: 'sonnet', effort: 'xhigh' },
    });
    expect(patched.json<VariantBody>()).toMatchObject({ model: 'sonnet', effort: 'xhigh' });
    const badEffort = await app.inject({
      method: 'PATCH',
      url: `/api/variants/${draft.id}`,
      payload: { effort: 'ultra' },
    });
    expect(badEffort.statusCode).toBe(400);

    const log = await app.inject({ method: 'GET', url: `/api/variants/${draft.id}/build-log` });
    expect(log.headers['content-type']).toMatch(/^text\/plain/);
    expect(log.body).toContain('派生');
  });

  test('路径穿越返回 400', async () => {
    for (const bad of ['../Cargo.toml', 'skills/../../x', 'Cargo.toml']) {
      const write = await app.inject({
        method: 'PUT',
        url: `/api/variants/${draft.id}/file`,
        payload: { path: bad, content: 'x' },
      });
      expect(write.statusCode, bad).toBe(400);
      const read = await app.inject({
        method: 'GET',
        url: `/api/variants/${draft.id}/file?path=${encodeURIComponent(bad)}`,
      });
      expect(read.statusCode, bad).toBe(400);
    }
    expect(fs.existsSync(path.join(config.variantsDir, 'x'))).toBe(false);
  });
});
