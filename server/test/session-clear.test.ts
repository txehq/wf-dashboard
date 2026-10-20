import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { sessionLines } from './helpers/session-copies.js';

// W74（Contracts 25.1、25.5）：清除只在管理表格中隐藏，任何 session 都可以清除，dashboard 中的数据保留。
// 真实的服务（buildApp）；run 的 session 是真实的 ic run（/ic TXE-3764，标题规则用它的首条消息）；
// 交互项的进程是 Claude Code 的替身（test/fixtures/live/claude-stand-in.mjs），"本机配置"在 .work/ 下
const work = path.join(import.meta.dirname, '../../.work/test-session-clear', randomUUID());
const projects = path.join(work, 'projects');
const cwd = path.join(work, 'cwd');
process.env.WFD_CLAUDE_BIN = path.join(import.meta.dirname, 'fixtures/live/claude-stand-in.mjs');
process.env.WFD_LOCAL_HOME = path.join(work, 'home');
process.env.WFD_CLAUDE_PROJECTS = projects;

const { config } = await import('../src/config.js');
const { buildApp } = await import('../src/api/app.js');
const { openDatabase } = await import('../src/db/index.js');
const { batches, runs, sessionImports, sessions, variants } = await import('../src/db/schema.js');
const { ingestFile } = await import('../src/ingest/ingest.js');
const { configSourceDirs } = await import('../src/ingest/session-config.js');
const { tailSessions } = await import('../src/ingest/session-import.js');
const { syncTasks } = await import('../src/tasks/loader.js');
const { IC_OTHER, copyOtherIcSession } = await import('./helpers/session-fixtures.js');

fs.mkdirSync(cwd, { recursive: true });
const db = openDatabase(path.join(work, 'db.sqlite'), config.migrationsDir);
syncTasks(db, config.tasksDir);
const app = await buildApp({
  db,
  sseHeartbeatMs: config.sseHeartbeatMs,
  logger: false,
  tasksDir: config.tasksDir,
  localHome: config.localHome,
});

// 交互进程的 hook 地址取服务监听的端口
beforeAll(async () => {
  await app.listen({ host: config.host, port: 0 });
});

afterAll(async () => {
  await app.close();
  db.$client.close();
  fs.rmSync(work, { recursive: true, force: true });
});

async function call<T>(
  method: 'GET' | 'POST',
  url: string,
  payload?: Record<string, unknown>,
): Promise<T> {
  const response =
    payload === undefined
      ? await app.inject({ method, url })
      : await app.inject({ method, url, payload });
  expect(response.statusCode, `${method} ${url}：${response.body}`).toBeLessThan(300);
  return response.json<T>();
}
const get = <T>(url: string) => call<T>('GET', url);
const post = <T>(url: string, payload: Record<string, unknown>) => call<T>('POST', url, payload);

// 管理表格中按 session id 搜索到的
const managed = async (id: string) =>
  (await get<{ sessions: { id: string }[] }>(`/api/sessions?q=${id}`)).sessions.map((s) => s.id);
const clearedAt = (id: string) =>
  db.select().from(sessionImports).where(eq(sessionImports.sessionId, id)).get()?.clearedAt;

interface Summary {
  title: string | null;
  cwd: string;
  requestCount: number;
}

test('清除 run 的 session：run 详情照常，管理表格中不见，重新导入后出现；各处的标题都是 /ic TXE-3764', async () => {
  const id = IC_OTHER.sessionId;
  const variantId = `v-clear-${randomUUID().slice(0, 8)}`;
  db.insert(variants)
    .values({
      id: variantId,
      name: variantId,
      workflowId: 'ic',
      baseCommit: '0'.repeat(40),
      skillsHash: 'a'.repeat(64),
      version: '0.0.0-eval.aaaaaaaa',
    })
    .run();
  db.insert(batches).values({ id: 'b-20261015-w74clr', repeats: 1 }).run();
  const runId = 'r-20261015-w74clr';
  db.insert(runs)
    .values({
      id: runId,
      batchId: 'b-20261015-w74clr',
      taskId: 'lfg-calculator',
      variantId,
      repeatIndex: 0,
      model: 'opus',
      effort: 'high',
      status: 'succeeded',
      sessionId: id,
      workspacePath: path.join(work, runId),
    })
    .run();
  const file = copyOtherIcSession(work);
  await post('/api/session-import', { engine: 'claude', files: [file] });
  const summary = await get<Summary & { runId: string }>(`/api/sessions/${id}`);
  expect(summary).toMatchObject({ title: '/ic TXE-3764', runId });
  const run = await get<{ costs: unknown; stages: unknown }>(`/api/runs/${runId}`);
  expect(run.stages).not.toBeNull();

  const plan = await post<{ sessions: { title: string }[]; blockers: unknown[] }>(
    '/api/sessions/action-plan',
    { action: 'clear', ids: [id] },
  );
  expect(plan).toMatchObject({ sessions: [{ title: '/ic TXE-3764', files: [] }], blockers: [] });
  await post('/api/sessions/clear', { ids: [id] });

  expect(await managed(id)).toEqual([]);
  const all = await get<{ ids: string[] }>('/api/sessions?idsOnly=true');
  expect(all.ids).not.toContain(id);
  expect(clearedAt(id)).toBeInstanceOf(Date);
  // 数据保留：详情、run 详情（阶段与花费）、分析的范围照常
  expect(await get<Summary>(`/api/sessions/${id}`)).toEqual(summary);
  expect(await get(`/api/runs/${runId}`)).toEqual(run);
  const scope = await post<{ sessions: { id: string; title: string }[] }>('/api/analyses/scope', {
    ids: [id],
  });
  expect(scope.sessions).toMatchObject([{ id, title: '/ic TXE-3764' }]);
  // 第三列：不再勾选，标题仍按列表的规则
  const column = await get<{ sessions: { id: string; title: string; imported: boolean }[] }>(
    `/api/session-import/sessions?config=local&cwd=${encodeURIComponent(summary.cwd)}`,
  );
  expect(column.sessions.find((s) => s.id === id)).toMatchObject({
    title: '/ic TXE-3764',
    imported: false,
  });

  await post('/api/session-import', { engine: 'claude', files: [file] });
  expect(await managed(id)).toEqual([id]);
  expect(clearedAt(id)).toBeNull();
});

test('清除运行中的交互项的 session：照常增量更新但不在管理表格中；再启动新的进程时重新出现', async () => {
  const id = randomUUID();
  const dir = path.join(projects, '-w74');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, sessionLines(id, cwd));
  ingestFile(db, file);
  const live = await post<{ id: string; status: string }>('/api/live/resume', {
    sessionId: id,
    variantId: null,
    driver: 'human',
  });
  expect(live.status).toBe('running');

  const plan = await get<{ blockers: unknown[] }>(
    `/api/sessions/action-plan?action=clear&ids=${id}`,
  );
  expect(plan.blockers).toEqual([]);
  await post('/api/sessions/clear', { ids: [id] });
  expect(await managed(id)).toEqual([]);
  expect((await get<{ status: string }>(`/api/live/${live.id}`)).status).toBe('running');

  // 文件变长：交互进程的 watcher 与每 5 秒的增量导入照常导入新增的部分，仍不在管理表格中。
  // resume 把 session 复制进了"本机配置"的 projects 目录，之后导入的是那一份
  const before = (await get<Summary>(`/api/sessions/${id}`)).requestCount;
  const more = sessionLines(id, cwd, ['还记得暗号吗？', '记得，青蛙-47。'])
    .split('\n')
    .slice(-3)
    .join('\n');
  const current = db.select().from(sessions).where(eq(sessions.id, id)).get()?.filePath;
  expect(current).toBe(path.join(config.localHome, '.claude', 'projects', live.id, `${id}.jsonl`));
  fs.appendFileSync(current ?? '', more);
  await tailSessions(db, configSourceDirs);
  expect((await get<Summary>(`/api/sessions/${id}`)).requestCount).toBe(before + 1);
  expect(await managed(id)).toEqual([]);

  await post(`/api/live/${live.id}/stop`, {});
  for (;;) {
    if ((await get<{ status: string }>(`/api/live/${live.id}`)).status === 'exited') break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  expect(await managed(id)).toEqual([]);
  // 在 Live 中 resume：新的进程启动时重新进入管理表格
  await post('/api/live/resume', { sessionId: id, variantId: null, driver: 'human' });
  expect(await managed(id)).toEqual([id]);
  expect(clearedAt(id)).toBeNull();
  await post(`/api/live/${live.id}/stop`, {});
});

test('早先的清除删除了记录的 session：增量导入时按导入记录重新导入，仍记为清除', async () => {
  const id = randomUUID();
  const dir = path.join(projects, '-w74-old');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, sessionLines(id, cwd));
  const at = new Date('2026-10-14T12:00:00.000Z');
  db.insert(sessionImports)
    .values({ sessionId: id, engine: 'claude', filePath: file, importedAt: at, clearedAt: at })
    .run();
  await tailSessions(db, configSourceDirs);
  expect((await get<Summary>(`/api/sessions/${id}`)).requestCount).toBeGreaterThan(0);
  expect(clearedAt(id)).toEqual(at);
  expect(await managed(id)).toEqual([]);
});
