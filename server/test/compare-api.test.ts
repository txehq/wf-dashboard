import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { artifacts, grades } from '../src/db/schema.js';
import { CompareRun, type CrossRunRef, RunArtifacts, SkillDiff } from '../src/grading/schema.js';
import { syncTasks } from '../src/tasks/loader.js';
import { insertRun } from './grading/seed.js';

const dbFile = path.join(config.repoRoot, '.work', 'test-db', `${randomUUID()}.sqlite`);
const db = openDatabase(dbFile, config.migrationsDir);
syncTasks(db, config.tasksDir);
const app = await buildApp({
  db,
  sseHeartbeatMs: config.sseHeartbeatMs,
  logger: false,
  tasksDir: config.tasksDir,
});
const marker = randomUUID().slice(0, 8);
const createdIds: string[] = [];
const crossRef: CrossRunRef = {
  runId: `cmp-b-${marker}`,
  kind: 'repo',
  requestSeq: 3,
  toolCallId: 'toolu_cross',
  excerpt: `gh api repos/txehq/wfe-cmp-b-${marker}/contents/package.json`,
};

interface VariantBody {
  id: string;
}

let base: VariantBody;
let edited: VariantBody;
let same: VariantBody;

beforeAll(async () => {
  await app.ready();
  base = (
    await app.inject({
      method: 'POST',
      url: '/api/variants',
      payload: { name: `cmp 基线 ${marker}` },
    })
  ).json<VariantBody>();
  createdIds.push(base.id);
  const derive = async (name: string) => {
    const derived = (
      await app.inject({
        method: 'POST',
        url: `/api/variants/${base.id}/derive`,
        payload: { name },
      })
    ).json<VariantBody>();
    createdIds.push(derived.id);
    return derived;
  };
  edited = await derive(`cmp 修改 ${marker}`);
  same = await derive(`cmp 相同 ${marker}`);
  const file = (
    await app.inject({
      method: 'GET',
      url: `/api/variants/${edited.id}/file?path=skills/interview/SKILL.md`,
    })
  ).json<{ content: string }>();
  await app.inject({
    method: 'PUT',
    url: `/api/variants/${edited.id}/file`,
    payload: {
      path: 'skills/interview/SKILL.md',
      content: `${file.content}\n<!-- ${marker} -->\n`,
    },
  });
  await app.inject({
    method: 'PUT',
    url: `/api/variants/${edited.id}/file`,
    payload: { path: 'skills/interview/references/new.md', content: '新文件\n' },
  });

  insertRun(db, {
    id: `cmp-a-${marker}`,
    taskId: 'lfg-calculator',
    variantId: base.id,
    status: 'succeeded',
    crossRunRefs: [crossRef],
    createdAt: new Date('2026-10-09T08:00:00Z'),
  });
  insertRun(db, {
    id: `cmp-b-${marker}`,
    taskId: 'ic-money-format',
    variantId: edited.id,
    status: 'succeeded',
    humanIntervened: true,
    githubRepo: `txehq/wfe-cmp-b-${marker}`,
    createdAt: new Date('2026-10-09T09:00:00Z'),
  });
  insertRun(db, {
    id: `cmp-c-${marker}`,
    taskId: 'lfg-calculator',
    variantId: base.id,
    status: 'running',
  });
  // 取消后评分过的 run 列出并标为 cancelled；排队中被取消、没有评分的 run 不列出
  insertRun(db, {
    id: `cmp-d-${marker}`,
    taskId: 'lfg-calculator',
    variantId: base.id,
    status: 'cancelled',
    createdAt: new Date('2026-10-09T10:00:00Z'),
  });
  db.insert(grades)
    .values({ runId: `cmp-d-${marker}`, kind: 'rubric', artifact: 'brief' })
    .run();
  insertRun(db, {
    id: `cmp-e-${marker}`,
    taskId: 'lfg-calculator',
    variantId: base.id,
    status: 'cancelled',
  });
  db.insert(artifacts)
    .values([
      {
        runId: `cmp-a-${marker}`,
        kind: 'brief',
        location: '/vault/Brief.md',
        snapshot: '# Brief\n',
      },
      {
        runId: `cmp-a-${marker}`,
        kind: 'research',
        location: '/vault/Research.md',
        snapshot: null,
      },
    ])
    .run();
});

afterAll(async () => {
  await app.close();
  db.$client.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  for (const id of createdIds) {
    fs.rmSync(path.join(config.variantsDir, id), { recursive: true, force: true });
  }
});

describe('compare 页面的只读接口', () => {
  test('GET /api/compare/runs 列出已评分与取消后评分过的 run，按创建时间排序', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/compare/runs' });
    expect(response.statusCode).toBe(200);
    const runs = CompareRun.array().parse(response.json());
    expect(runs).toEqual([
      {
        id: `cmp-a-${marker}`,
        variantId: base.id,
        taskId: 'lfg-calculator',
        cancelled: false,
        humanIntervened: false,
        crossRunRefs: [crossRef],
        sourceRefs: [],
        createdAt: '2026-10-09T08:00:00.000Z',
        model: 'opus',
      },
      {
        id: `cmp-b-${marker}`,
        variantId: edited.id,
        taskId: 'ic-money-format',
        cancelled: false,
        humanIntervened: true,
        crossRunRefs: [],
        sourceRefs: [],
        createdAt: '2026-10-09T09:00:00.000Z',
        model: 'opus',
      },
      {
        id: `cmp-d-${marker}`,
        variantId: base.id,
        taskId: 'lfg-calculator',
        cancelled: true,
        humanIntervened: false,
        crossRunRefs: [],
        sourceRefs: [],
        createdAt: '2026-10-09T10:00:00.000Z',
        model: 'opus',
      },
    ]);
    const cancelled = await app.inject({
      method: 'GET',
      url: `/api/compare/runs/cmp-d-${marker}/artifacts`,
    });
    expect(cancelled.statusCode).toBe(200);
    const ungraded = await app.inject({
      method: 'GET',
      url: `/api/compare/runs/cmp-e-${marker}/artifacts`,
    });
    expect(ungraded.statusCode).toBe(404);
  });

  test('GET /api/compare/runs/:id/artifacts 返回产物快照与仓库；未评分与不存在的 run 为 404', async () => {
    const ok = await app.inject({
      method: 'GET',
      url: `/api/compare/runs/cmp-a-${marker}/artifacts`,
    });
    expect(ok.statusCode).toBe(200);
    expect(RunArtifacts.parse(ok.json())).toEqual({
      runId: `cmp-a-${marker}`,
      prUrl: null,
      githubRepo: null,
      artifacts: [
        { kind: 'brief', location: '/vault/Brief.md', snapshot: '# Brief\n' },
        { kind: 'research', location: '/vault/Research.md', snapshot: null },
      ],
    });
    const ic = RunArtifacts.parse(
      (
        await app.inject({ method: 'GET', url: `/api/compare/runs/cmp-b-${marker}/artifacts` })
      ).json(),
    );
    expect(ic.githubRepo).toBe(`txehq/wfe-cmp-b-${marker}`);
    expect(ic.artifacts).toEqual([]);

    const running = await app.inject({
      method: 'GET',
      url: `/api/compare/runs/cmp-c-${marker}/artifacts`,
    });
    expect(running.statusCode).toBe(404);
    expect(running.json<{ message: string }>().message).toBe(`run cmp-c-${marker} 尚未评分`);
    const missing = await app.inject({ method: 'GET', url: '/api/compare/runs/nope/artifacts' });
    expect(missing.statusCode).toBe(404);
  });

  test('GET /api/compare/skill-diff 逐文件对比两个 variant 的 skills/', async () => {
    const forward = SkillDiff.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/compare/skill-diff?from=${base.id}&to=${edited.id}`,
        })
      ).json(),
    );
    expect(forward.files.map((f) => [f.path, f.status])).toEqual([
      ['skills/interview/SKILL.md', 'modified'],
      ['skills/interview/references/new.md', 'added'],
    ]);
    const [skill] = forward.files;
    expect(skill?.newContent.endsWith(`<!-- ${marker} -->\n`)).toBe(true);
    expect(skill?.patch).toContain(`+<!-- ${marker} -->`);

    const backward = SkillDiff.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/compare/skill-diff?from=${edited.id}&to=${base.id}`,
        })
      ).json(),
    );
    expect(backward.files.map((f) => f.status)).toEqual(['modified', 'removed']);

    const identical = SkillDiff.parse(
      (
        await app.inject({
          method: 'GET',
          url: `/api/compare/skill-diff?from=${base.id}&to=${same.id}`,
        })
      ).json(),
    );
    expect(identical.files).toEqual([]);

    const missing = await app.inject({
      method: 'GET',
      url: `/api/compare/skill-diff?from=${base.id}&to=nope`,
    });
    expect(missing.statusCode).toBe(404);
  });
});
