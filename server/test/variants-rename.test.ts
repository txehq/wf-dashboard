import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import {
  analyses,
  liveProcesses,
  liveSessions,
  sessions,
  variants as variantsTable,
  workflowDrafts,
} from '../src/db/schema.js';
import { type AppEvent, events } from '../src/events.js';
import { newAnalysisId } from '../src/insights/index.js';
import { syncTasks } from '../src/tasks/loader.js';
import { insertRun, insertVariant } from './grading/seed.js';

// variant 改名（Contracts 16.4）：各处都按 id 取名字，改名后所有接口返回新名字
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
const workflowId = `rename-${marker}`;
const newName = `新名字 ${marker}`;

interface VariantBody {
  id: string;
  name: string;
  workflowId: string;
}

let first: VariantBody;
let second: VariantBody;
const runId = `rename-run-${marker}`;
const lfgVariantId = `rename-lfg-${marker}`;
const liveId = `l-rename-${marker}`;
const draftId = `d-rename-${marker}`;
const analysisId = newAnalysisId();
let sessionId = '';
const installFile = () => path.join(config.dataDir, 'installs', `${first.id}.json`);

const patch = (id: string, payload: object) =>
  app.inject({ method: 'PATCH', url: `/api/variants/${id}`, payload });

beforeAll(async () => {
  await app.ready();
  const created = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    payload: {
      id: workflowId,
      name: `改名 ${marker}`,
      description: '',
      definition: { id: workflowId, name: `改名 ${marker}`, stages: [{ id: `scan-${marker}` }] },
    },
  });
  expect(created.statusCode).toBe(201);
  const all = (await app.inject({ method: 'GET', url: '/api/variants' })).json<VariantBody[]>();
  const draft = all.find((v) => v.workflowId === workflowId);
  if (draft === undefined) throw new Error(`${workflowId} 没有初稿`);
  first = draft;
  second = (
    await app.inject({
      method: 'POST',
      url: `/api/variants/${first.id}/derive`,
      payload: { name: `第二个 ${marker}` },
    })
  ).json<VariantBody>();

  // 引用这个 variant 的各处：run 与它的 session（手动绑定）、交互进程、分析、草稿、安装清单（旧清单记着旧名字）
  insertVariant(db, lfgVariantId);
  sessionId = insertRun(db, { id: runId, taskId: 'lfg-calculator', variantId: lfgVariantId });
  db.update(sessions)
    .set({ variantId: first.id, variantBinding: 'manual' })
    .where(eq(sessions.id, sessionId))
    .run();
  const now = new Date();
  db.insert(liveSessions)
    .values({
      id: liveId,
      title: '改名的交互',
      environment: 'isolated',
      cwd: path.join(config.dataDir, 'live', liveId),
      updatedAt: now,
    })
    .run();
  db.insert(liveProcesses)
    .values({
      liveId,
      kind: 'start',
      variantId: first.id,
      status: 'exited',
      driver: 'human',
      startedAt: now,
      endedAt: now,
    })
    .run();
  db.insert(analyses)
    .values({
      id: analysisId,
      engine: 'claude',
      model: 'claude-opus-5-5',
      variantId: first.id,
      sessionIds: [sessionId],
      status: 'failed',
      steps: [],
    })
    .run();
  db.insert(workflowDrafts)
    .values({ id: draftId, mode: 'variant', workflowId, requirement: '改名', status: 'saved' })
    .run();
  db.update(variantsTable).set({ draftId }).where(eq(variantsTable.id, first.id)).run();
  fs.mkdirSync(path.dirname(installFile()), { recursive: true });
  fs.writeFileSync(
    installFile(),
    JSON.stringify({
      variantId: first.id,
      variantName: first.name,
      workflowId,
      installedAt: now.getTime(),
      targets: { claude: '/nowhere/.claude/skills', agents: '/nowhere/.agents/skills' },
      dirs: [],
      files: [],
    }),
  );
});

afterAll(async () => {
  fs.rmSync(installFile(), { force: true });
  await app.close();
  db.$client.close();
  fs.rmSync(dbFile, { force: true });
});

describe('PATCH /api/variants/:id { name }', () => {
  test('空白与超过 100 字 400，同一 workflow 内同名 409，原文说明', async () => {
    const blank = await patch(first.id, { name: '   ' });
    expect(blank.statusCode).toBe(400);
    expect(blank.json<{ message: string }>().message).toBe('variant 的名字不能为空');
    const long = await patch(first.id, { name: 'x'.repeat(101) });
    expect(long.statusCode).toBe(400);
    expect(long.json<{ message: string }>().message).toContain('最多 100 字');
    const taken = await patch(first.id, { name: second.name });
    expect(taken.statusCode).toBe(409);
    expect(taken.json<{ message: string }>().message).toBe(
      `名称已被使用：${second.name} (${workflowId})`,
    );
    expect(
      (await app.inject({ method: 'GET', url: `/api/variants/${first.id}` })).json<VariantBody>()
        .name,
    ).toBe(first.name);
  });

  test('改名：去掉首尾空白，记入历史，发出 variant.updated；100 字正好可以', async () => {
    const seen: AppEvent[] = [];
    const stop = events.subscribe((e) => seen.push(e));
    const renamed = await patch(first.id, { name: `  ${newName}  ` });
    stop();
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<VariantBody>().name).toBe(newName);
    expect(seen).toContainEqual({ type: 'variant.updated', variantId: first.id });
    const history = (
      await app.inject({ method: 'GET', url: `/api/variants/${first.id}/history` })
    ).json<{ kind: string; from: string; to: string; at: number }[]>();
    expect(history.map(({ kind, from, to }) => ({ kind, from, to }))).toEqual([
      { kind: 'rename', from: first.name, to: newName },
    ]);
    const hundred = 'y'.repeat(100);
    expect((await patch(second.id, { name: hundred })).json<VariantBody>().name).toBe(hundred);
  });

  test('改名后各处接口返回新名字：variants、sessions 的绑定、live、runs、analyses、草稿与安装清单', async () => {
    const get = async <T>(url: string) => (await app.inject({ method: 'GET', url })).json<T>();
    const list = await get<VariantBody[]>('/api/variants');
    expect(list.find((v) => v.id === first.id)?.name).toBe(newName);

    const sessionList = await get<{ sessions: { id: string; variant: { name: string } | null }[] }>(
      `/api/sessions?limit=500`,
    );
    expect(sessionList.sessions.find((s) => s.id === sessionId)?.variant?.name).toBe(newName);
    const binding = await get<{ variant: { name: string } | null }>(
      `/api/sessions/${sessionId}/binding`,
    );
    expect(binding.variant?.name).toBe(newName);

    const liveList = await get<{ id: string; variantName: string | null }[]>(
      '/api/live?includeHidden=true',
    );
    expect(liveList.find((l) => l.id === liveId)?.variantName).toBe(newName);

    // run 只能用有评测类型的 workflow 的 variant：内置 lfg 的一个 variant，同样改名
    const lfgName = `lfg 新名字 ${marker}`;
    expect((await patch(lfgVariantId, { name: lfgName })).statusCode).toBe(200);
    const runs = await get<{ id: string; variantName: string }[]>('/api/runs');
    expect(runs.find((r) => r.id === runId)?.variantName).toBe(lfgName);
    expect(await get<{ variantName: string }>(`/api/runs/${runId}`)).toMatchObject({
      variantName: lfgName,
    });

    const analysesList = await get<{ id: string; variantName: string }[]>('/api/analyses');
    expect(analysesList.find((a) => a.id === analysisId)?.variantName).toBe(newName);

    const draft = await get<{ savedVariants: { id: string; name: string }[] }>(
      `/api/workflow-drafts/${draftId}`,
    );
    expect(draft.savedVariants.find((v) => v.id === first.id)?.name).toBe(newName);

    const install = await get<{ installed: { variantName: string } | null }>(
      `/api/variants/${first.id}/install`,
    );
    expect(install.installed?.variantName).toBe(newName);
  });
});
