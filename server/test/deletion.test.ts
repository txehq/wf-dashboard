import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { sessionLines } from './helpers/session-copies.js';

// 基础档（Contracts 第 24 节）：删除 variant 与 workflow。能否删除与拒绝的原文、关联 session 的两种处理（一起删除时连同
// 磁盘上的原始文件与 Live 项）、保留的记录与"（已删除）"、删除的文件（draft 与已构建的、共用的目录、本机安装的卸载）、
// 删除 workflow、指向 variant、workflow、草稿与 Live 项的每一条外键。session 的文件都在测试自己建的配置目录中，本机安装用测试自己的 HOME，不碰用户的 ~/.claude
const { buildApp } = await import('../src/api/app.js');
const { config } = await import('../src/config.js');
const { openDatabase } = await import('../src/db/index.js');
const schema = await import('../src/db/schema.js');
const { ingestFile } = await import('../src/ingest/ingest.js');
const { syncTasks } = await import('../src/tasks/loader.js');
const { createVariants } = await import('../src/variants/index.js');

const work = path.join(config.repoRoot, '.work', 'test-deletion', randomUUID());
const home = path.join(work, 'home');
const dbFile = path.join(config.repoRoot, '.work', 'test-db', `${randomUUID()}.sqlite`);
const db = openDatabase(dbFile, config.migrationsDir);
syncTasks(db, config.tasksDir);
const app = await buildApp({
  db,
  sseHeartbeatMs: config.sseHeartbeatMs,
  logger: false,
  tasksDir: config.tasksDir,
});
// 同一数据库与数据目录上的 variants 模块，本机安装装进测试自己的 HOME（Contracts 18.6）
const local = createVariants({
  db,
  dataDir: config.dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
  home,
});
const marker = randomUUID().slice(0, 6);

interface Variant {
  id: string;
  name: string;
  workflowId: string;
  parentId: string | null;
  deletedAt: string | null;
  installDir: string;
  storageId: string | null;
}
interface Plan {
  target: { kind: string; id: string; name: string };
  variants: { id: string; name: string }[];
  blockers: { kind: string; id: string; label: string }[];
  dirs: string[];
  installs: { variantId: string; dirs: string[] }[];
  sessions: { count: number; files: string[]; liveItems: { id: string; title: string }[] };
  retained: {
    runs: number;
    runSessions: number;
    analyses: number;
    liveItems: number;
    children: { id: string; name: string }[];
    drafts: number;
  };
  drafts: { id: string; liveId: string | null }[];
}

const get = async <T>(url: string): Promise<T> => {
  const response = await app.inject({ method: 'GET', url });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
};
const post = (url: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url, payload });
const del = (url: string, sessions: unknown) =>
  app.inject({ method: 'DELETE', url, payload: { sessions } });

// 从空白新建的 workflow 与它的第一个 variant「初稿」，另派生 extra 个 variant
async function newFlow(prefix: string, extra: number) {
  const id = `${prefix}-${marker}`;
  const made = await post('/api/workflows', {
    id,
    name: `删除 ${prefix} ${marker}`,
    description: '',
    definition: { id, name: `删除 ${prefix} ${marker}`, stages: [{ id: 'step' }] },
  });
  expect(made.statusCode, made.body).toBe(201);
  const first = local.list().find((v) => v.workflowId === id);
  if (first === undefined) throw new Error(`workflow ${id} 没有建出初稿`);
  const others: string[] = [];
  for (let i = 0; i < extra; i++) {
    const derived = await post(`/api/variants/${first.id}/derive`, { name: `派生 ${String(i)}` });
    expect(derived.statusCode, derived.body).toBe(201);
    others.push(derived.json<Variant>().id);
  }
  return { id, first: first.id, others };
}

// 绑定到 variant 的一个本机 session：jsonl、子代理与 tool-results 目录都在测试自己的配置目录 projects/ 下
function boundSession(variantId: string, binding: 'manual' | 'auto' = 'manual') {
  const sessionId = randomUUID();
  const projects = path.join(work, 'claude-config', 'projects', `-w61-${marker}`);
  const file = path.join(projects, `${sessionId}.jsonl`);
  fs.mkdirSync(path.join(projects, sessionId, 'subagents'), { recursive: true });
  fs.mkdirSync(path.join(projects, sessionId, 'tool-results'), { recursive: true });
  fs.writeFileSync(path.join(projects, sessionId, 'tool-results', 'x.txt'), 'tool result\n');
  fs.writeFileSync(file, sessionLines(sessionId, work));
  ingestFile(db, file);
  db.update(schema.sessions)
    .set({ variantId, variantBinding: binding })
    .where(eq(schema.sessions.id, sessionId))
    .run();
  return { sessionId, file, dir: path.join(projects, sessionId) };
}

// session 所属的 Live 项（已结束的进程用过 variantId）与它的目录
function liveItemFor(
  sessionId: string | null,
  variantId: string | null,
  status: 'running' | 'exited',
) {
  const liveId = `l-20261014-${randomUUID().slice(0, 6)}`;
  db.insert(schema.liveSessions)
    .values({
      id: liveId,
      claudeSessionId: sessionId,
      title: `交互 ${liveId}`,
      environment: 'real',
      cwd: work,
      updatedAt: new Date(),
    })
    .run();
  db.insert(schema.liveProcesses)
    .values({
      liveId,
      kind: 'start',
      variantId,
      model: 'opus',
      effort: 'high',
      pid: 1,
      status,
      driver: 'human',
      startedAt: new Date(),
    })
    .run();
  if (sessionId !== null) {
    db.update(schema.sessions).set({ liveId }).where(eq(schema.sessions.id, sessionId)).run();
  }
  const dir = path.join(config.liveDir, liveId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'pty.log'), 'pty\n');
  return { liveId, dir };
}

function runOf(variantId: string, status: (typeof schema.runStatuses)[number]) {
  const suffix = randomUUID().slice(0, 6);
  const batchId = `b-20261014-${suffix}`;
  const runId = `r-20261014-${suffix}`;
  db.insert(schema.batches).values({ id: batchId, repeats: 1 }).run();
  db.insert(schema.runs)
    .values({
      id: runId,
      batchId,
      taskId: 'lfg-calculator',
      variantId,
      repeatIndex: 0,
      model: 'opus',
      effort: 'high',
      status,
      sessionId: randomUUID(),
      workspacePath: work,
    })
    .run();
  return runId;
}

function analysisOf(variantId: string, status: (typeof schema.analysisStatuses)[number]) {
  const id = `a-20261014-${randomUUID().slice(0, 6)}`;
  db.insert(schema.analyses)
    .values({
      id,
      engine: 'claude',
      model: 'opus',
      variantId,
      analysisVariantId: null,
      sessionIds: [],
      status,
      steps: [],
    })
    .run();
  // 成功的分析在分析目录中留下修改建议的结果（这里没有修改建议）
  const dir = path.join(config.dataDir, 'analyses', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'proposals.json'), '[]\n');
  return id;
}

const isDeleted = (id: string) =>
  db.select().from(schema.variants).where(eq(schema.variants.id, id)).get()?.deletedAt !== null;
const variantRow = (id: string) =>
  db.select().from(schema.variants).where(eq(schema.variants.id, id)).get();
const sessionRow = (id: string) =>
  db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
const requestRows = (sessionId: string) =>
  db.select().from(schema.requests).where(eq(schema.requests.sessionId, sessionId)).all();
const liveRow = (id: string) =>
  db.select().from(schema.liveSessions).where(eq(schema.liveSessions.id, id)).get();
const draftRow = (id: string) =>
  db.select().from(schema.workflowDrafts).where(eq(schema.workflowDrafts.id, id)).get();
const workflowRecord = (id: string) =>
  db.select().from(schema.workflowTable).where(eq(schema.workflowTable.id, id)).get();

beforeAll(async () => {
  await app.ready();
});

afterAll(async () => {
  await app.close();
  db.$client.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

describe('删除 variant 与 workflow（基础档）', { timeout: 60_000 }, () => {
  test('拒绝：内置 workflow、最后一个 variant、进行中的 run、运行中的交互、进行中的分析、正在准备的草稿，各以原文 409', async () => {
    for (const builtin of ['lfg', 'ic', 'session-analysis']) {
      const plan = await get<Plan>(`/api/workflows/${builtin}/delete-plan`);
      expect(plan.blockers.map((b) => b.kind)).toContain('builtin');
      const rejected = await del(`/api/workflows/${builtin}`, 'delete');
      expect(rejected.statusCode).toBe(409);
      expect(rejected.body).toContain(`${builtin} 是内置的 workflow，不能删除`);
    }
    const flow = await newFlow('refuse', 1);
    const [second] = flow.others;
    if (second === undefined) throw new Error('没有派生出 variant');
    // 最后一个 variant：另一个先删去
    const lone = await newFlow('lone', 0);
    const last = await del(`/api/variants/${lone.first}`, 'delete');
    expect(last.statusCode).toBe(409);
    expect(last.body).toContain(
      `是 workflow ${lone.id} 的最后一个 variant，不能单独删除；要删就删除 workflow`,
    );

    const runId = runOf(second, 'running');
    const live = liveItemFor(null, second, 'running');
    const analysisId = analysisOf(second, 'queued');
    const draftId = `d-20261014-${randomUUID().slice(0, 6)}`;
    db.insert(schema.workflowDrafts)
      .values({
        id: draftId,
        mode: 'variant',
        workflowId: flow.id,
        baseVariantId: second,
        requirement: '准备中',
        status: 'preparing',
      })
      .run();
    const plan = await get<Plan>(`/api/variants/${second}/delete-plan`);
    expect(plan.blockers.map((b) => [b.kind, b.id])).toEqual([
      ['run', runId],
      ['live', live.liveId],
      ['analysis', analysisId],
      ['draft', draftId],
    ]);
    const rejected = await del(`/api/variants/${second}`, 'delete');
    expect(rejected.statusCode).toBe(409);
    const { message } = rejected.json<{ message: string }>();
    expect(message).toContain(`不能删除 variant 派生 0：`);
    expect(message).toContain(`run ${runId}（running）`);
    expect(message).toContain(`交互 交互 ${live.liveId}（运行中）`);
    expect(message).toContain(`分析 ${analysisId}（queued）`);
    expect(message).toContain(`草稿 ${draftId}（正在准备）`);
    expect(isDeleted(second)).toBe(false);
    // 都结束之后可以删
    db.update(schema.runs).set({ status: 'failed' }).where(eq(schema.runs.id, runId)).run();
    db.update(schema.liveProcesses)
      .set({ status: 'exited' })
      .where(eq(schema.liveProcesses.liveId, live.liveId))
      .run();
    db.update(schema.analyses)
      .set({ status: 'failed' })
      .where(eq(schema.analyses.id, analysisId))
      .run();
    db.update(schema.workflowDrafts)
      .set({ status: 'failed' })
      .where(eq(schema.workflowDrafts.id, draftId))
      .run();
    expect((await get<Plan>(`/api/variants/${second}/delete-plan`)).blockers).toEqual([]);
    const done = await del(`/api/variants/${second}`, { rebindTo: null });
    expect(done.statusCode, done.body).toBe(200);
    expect(isDeleted(second)).toBe(true);
  });

  test('一起删除：session 连同 jsonl、子代理与 tool-results 目录、它的 Live 项与目录；run 的 session 随 run 保留', async () => {
    const flow = await newFlow('together', 1);
    const [victim] = flow.others;
    if (victim === undefined) throw new Error('没有派生出 variant');
    const a = boundSession(victim);
    const b = boundSession(victim, 'auto');
    const live = liveItemFor(a.sessionId, victim, 'exited');
    // run 的 session：绑定为 run，不在两个选择之内
    const runId = runOf(victim, 'succeeded');
    const runSession = boundSession(victim);
    db.update(schema.sessions)
      .set({ variantBinding: 'run', runId })
      .where(eq(schema.sessions.id, runSession.sessionId))
      .run();
    const plan = await get<Plan>(`/api/variants/${victim}/delete-plan`);
    expect(plan.sessions.count).toBe(2);
    expect(plan.sessions.files.sort()).toEqual([a.file, a.dir, b.file, b.dir].sort());
    expect(plan.sessions.liveItems).toEqual([{ id: live.liveId, title: `交互 ${live.liveId}` }]);
    expect(plan.retained).toMatchObject({ runs: 1, runSessions: 1, liveItems: 0 });
    const done = await del(`/api/variants/${victim}`, 'delete');
    expect(done.statusCode, done.body).toBe(200);
    for (const s of [a, b]) {
      expect(sessionRow(s.sessionId)).toBeUndefined();
      expect(requestRows(s.sessionId)).toEqual([]);
      expect(fs.existsSync(s.file)).toBe(false);
      expect(fs.existsSync(s.dir)).toBe(false);
    }
    expect(liveRow(live.liveId)).toBeUndefined();
    expect(fs.existsSync(live.dir)).toBe(false);
    // run 的 session 保留，仍指向已删除的 variant
    const kept = sessionRow(runSession.sessionId);
    expect(kept).toMatchObject({ variantId: victim, variantBinding: 'run' });
    expect(fs.existsSync(runSession.file)).toBe(true);
  });

  test('改绑：默认本机配置（不绑定，manual）；可以改绑到其他 workflow 的 variant；不能改绑到要删的或已删除的', async () => {
    const flow = await newFlow('rebind', 2);
    const [x, y] = flow.others;
    if (x === undefined || y === undefined) throw new Error('没有派生出 variant');
    const other = await newFlow('rebind-to', 0);
    const toLocal = boundSession(x);
    const toOther = boundSession(y);
    const self = await del(`/api/variants/${x}`, { rebindTo: x });
    expect(self.statusCode).toBe(400);
    expect(self.body).toContain('不能改绑到要删除的 variant 派生 0');
    expect((await del(`/api/variants/${x}`, { rebindTo: null })).statusCode).toBe(200);
    expect(sessionRow(toLocal.sessionId)).toMatchObject({
      variantId: null,
      variantBinding: 'manual',
    });
    expect(fs.existsSync(toLocal.file)).toBe(true);
    const gone = await del(`/api/variants/${y}`, { rebindTo: x });
    expect(gone.statusCode).toBe(404);
    expect(gone.body).toContain('variant 派生 0 已删除');
    expect((await del(`/api/variants/${y}`, { rebindTo: other.first })).statusCode).toBe(200);
    expect(sessionRow(toOther.sessionId)).toMatchObject({
      variantId: other.first,
      variantBinding: 'manual',
    });
  });

  test('保留的记录：Runs、Compare、Analyses、Live、子 variant 与草稿显示"<名字>（已删除）"；列表与选择中不再出现', async () => {
    const flow = await newFlow('kept', 1);
    const [parent] = flow.others;
    if (parent === undefined) throw new Error('没有派生出 variant');
    const child = await post(`/api/variants/${parent}/derive`, { name: '孙' });
    const childId = child.json<Variant>().id;
    const runId = runOf(parent, 'succeeded');
    const analysisId = analysisOf(parent, 'succeeded');
    const live = liveItemFor(null, parent, 'exited');
    const draftId = `d-20261014-${randomUUID().slice(0, 6)}`;
    db.insert(schema.workflowDrafts)
      .values({
        id: draftId,
        mode: 'variant',
        workflowId: flow.id,
        baseVariantId: parent,
        requirement: '保留',
        status: 'open',
      })
      .run();
    const plan = await get<Plan>(`/api/variants/${parent}/delete-plan`);
    expect(plan.retained).toMatchObject({
      runs: 1,
      analyses: 1,
      liveItems: 1,
      children: [{ id: childId, name: '孙' }],
      drafts: 1,
    });
    expect((await del(`/api/variants/${parent}`, 'delete')).statusCode).toBe(200);
    const shown = '派生 0（已删除）';
    const runsList = await get<{ id: string; variantName: string }[]>('/api/runs');
    expect(runsList.find((r) => r.id === runId)?.variantName).toBe(shown);
    const analysesList = await get<{ id: string; variantName: string }[]>('/api/analyses');
    expect(analysesList.find((a) => a.id === analysisId)?.variantName).toBe(shown);
    const detail = await get<{ variantName: string; variantDeleted: boolean }>(
      `/api/analyses/${analysisId}`,
    );
    expect(detail).toMatchObject({ variantName: shown, variantDeleted: true });
    const item = await get<{ processes: { variantName: string | null }[] }>(
      `/api/live/${live.liveId}`,
    );
    expect(item.processes[0]?.variantName).toBe(shown);
    // 子 variant 的 parent 与草稿的底子保留原来的 id；variant 本身只用于显示名字
    expect((await get<Variant>(`/api/variants/${childId}`)).parentId).toBe(parent);
    expect((await get<Variant>(`/api/variants/${parent}`)).deletedAt).not.toBeNull();
    expect(draftRow(draftId)?.baseVariantId).toBe(parent);
    // 列表与选择框中不再出现；Compare 用 includeDeleted 取到它显示保留的 run
    expect((await get<Variant[]>('/api/variants')).map((v) => v.id)).not.toContain(parent);
    const all = await get<Variant[]>('/api/variants?includeDeleted=1');
    expect(all.find((v) => v.id === parent)?.deletedAt).not.toBeNull();
    // 已删除的不能再派生；同名的新 variant 可以再建
    expect((await post(`/api/variants/${parent}/derive`, { name: 'x' })).statusCode).toBe(404);
    const renamed = await post(`/api/variants/${childId}/derive`, { name: '派生 0' });
    expect(renamed.statusCode).toBe(201);
  });

  test('删除的文件：未构建的 draft 删 src 与存档；已构建的另删构建产物与配置目录；共用目录到最后一个引用才删；本机安装先卸载', async () => {
    const flow = await newFlow('files', 3);
    const [draftV, builtV, sharer] = flow.others;
    if (draftV === undefined || builtV === undefined || sharer === undefined) {
      throw new Error('没有派生出 variant');
    }
    // 未构建：src、构建日志与覆盖前的存档（data/variant-history/<id>）
    const draftDir = local.layout(draftV).dir;
    const historyDir = path.join(config.dataDir, 'variant-history', draftV);
    fs.mkdirSync(path.join(historyDir, 'snap', 'src'), { recursive: true });
    const draftPlan = await get<Plan>(`/api/variants/${draftV}/delete-plan`);
    expect(draftPlan.dirs).toEqual([draftDir, historyDir].sort());
    expect((await del(`/api/variants/${draftV}`, 'delete')).statusCode).toBe(200);
    expect(fs.existsSync(draftDir)).toBe(false);
    expect(fs.existsSync(historyDir)).toBe(false);

    // 已构建并装在本机：构建产物与隔离配置目录在 variant 目录中；先按清单卸载
    await local.build(builtV);
    const built = local.layout(builtV);
    expect(fs.existsSync(path.join(built.claudeDir, 'skills'))).toBe(true);
    local.installLocal(builtV);
    const installed = path.join(home, '.claude', 'skills', 'step', 'SKILL.md');
    expect(fs.existsSync(installed)).toBe(true);
    fs.appendFileSync(installed, '\n改过\n');
    const blocked = await get<Plan>(`/api/variants/${builtV}/delete-plan`);
    expect(blocked.blockers.map((b) => b.kind)).toEqual(['install']);
    const refused = await del(`/api/variants/${builtV}`, 'delete');
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toContain(installed);
    expect(fs.existsSync(built.dir)).toBe(true);
    fs.writeFileSync(installed, fs.readFileSync(path.join(built.skills, 'step', 'SKILL.md')));
    const builtPlan = await get<Plan>(`/api/variants/${builtV}/delete-plan`);
    expect(builtPlan.installs.map((i) => i.variantId)).toEqual([builtV]);
    expect((await del(`/api/variants/${builtV}`, 'delete')).statusCode).toBe(200);
    expect(fs.existsSync(built.dir)).toBe(false);
    expect(fs.existsSync(path.join(home, '.claude', 'skills', 'step'))).toBe(false);
    expect(fs.existsSync(path.join(config.dataDir, 'installs', `${builtV}.json`))).toBe(false);

    // 共用目录（16.4 的迁移拆出的两个 variant）：sharer 用 first 的目录
    db.update(schema.variants)
      .set({ storageId: flow.first })
      .where(eq(schema.variants.id, sharer))
      .run();
    const shared = local.layout(flow.first).dir;
    const sharerPlan = await get<Plan>(`/api/variants/${sharer}/delete-plan`);
    expect(sharerPlan.dirs).not.toContain(shared);
    expect((await del(`/api/variants/${sharer}`, 'delete')).statusCode).toBe(200);
    expect(fs.existsSync(shared)).toBe(true);
    // 最后一个引用它的：删 workflow 时 first 一起删除，目录随之删去
    const wfPlan = await get<Plan>(`/api/workflows/${flow.id}/delete-plan`);
    expect(wfPlan.dirs).toContain(shared);
    expect((await del(`/api/workflows/${flow.id}`, 'delete')).statusCode).toBe(200);
    expect(fs.existsSync(shared)).toBe(false);
  });

  test('本机配置的 Magi Agent 的 session 与 Live 项不随 variant 删除：选一起删除时 session 改为本机配置，文件与 Live 项都在', async () => {
    const flow = await newFlow('magi', 1);
    const [victim] = flow.others;
    if (victim === undefined) throw new Error('没有派生出 variant');
    const normal = boundSession(victim);
    const agent = boundSession(victim, 'auto');
    const agentLive = liveItemFor(agent.sessionId, null, 'exited');
    db.update(schema.liveSessions)
      .set({ purpose: 'agent', agentConfig: 'local' })
      .where(eq(schema.liveSessions.id, agentLive.liveId))
      .run();
    const plan = await get<Plan & { sessions: { agent: number } }>(
      `/api/variants/${victim}/delete-plan`,
    );
    expect(plan.sessions).toMatchObject({ count: 1, agent: 1, liveItems: [] });
    expect(plan.sessions.files.sort()).toEqual([normal.file, normal.dir].sort());
    expect((await del(`/api/variants/${victim}`, 'delete')).statusCode).toBe(200);
    expect(sessionRow(normal.sessionId)).toBeUndefined();
    expect(sessionRow(agent.sessionId)).toMatchObject({
      variantId: null,
      variantBinding: 'manual',
    });
    expect(fs.existsSync(agent.file)).toBe(true);
    expect(fs.existsSync(agent.dir)).toBe(true);
    expect(liveRow(agentLive.liveId)).toMatchObject({ purpose: 'agent', agentConfig: 'local' });
    expect(fs.existsSync(agentLive.dir)).toBe(true);
  });

  test('用 variant 配置的 Magi Agent 的会话与这个 variant 的其他 session 相同处理：一起删除时删去，改绑时改用改绑的配置', async () => {
    const flow = await newFlow('magi-variant', 2);
    const [deleted, rebound] = flow.others;
    if (deleted === undefined || rebound === undefined) throw new Error('没有派生出 variant');
    const asAgent = (liveId: string, config: string) => {
      db.update(schema.liveSessions)
        .set({ purpose: 'agent', agentConfig: config })
        .where(eq(schema.liveSessions.id, liveId))
        .run();
    };
    // 一起删除：session（连同文件）与 Live 项都删除；还没有 session 的 Magi Agent 项也删除
    const agent = boundSession(deleted, 'auto');
    const agentLive = liveItemFor(agent.sessionId, deleted, 'exited');
    asAgent(agentLive.liveId, deleted);
    const fresh = liveItemFor(null, deleted, 'exited');
    asAgent(fresh.liveId, deleted);
    const plan = await get<Plan & { sessions: { agent: number } }>(
      `/api/variants/${deleted}/delete-plan`,
    );
    expect(plan.sessions.count).toBe(1);
    expect(plan.sessions.agent).toBe(0);
    expect(plan.sessions.liveItems.map((i) => i.id).sort()).toEqual(
      [agentLive.liveId, fresh.liveId].sort(),
    );
    expect(plan.sessions.files.sort()).toEqual([agent.file, agent.dir].sort());
    expect((await del(`/api/variants/${deleted}`, 'delete')).statusCode).toBe(200);
    expect(sessionRow(agent.sessionId)).toBeUndefined();
    expect(fs.existsSync(agent.file)).toBe(false);
    expect(liveRow(agentLive.liveId)).toBeUndefined();
    expect(liveRow(fresh.liveId)).toBeUndefined();
    expect(fs.existsSync(agentLive.dir)).toBe(false);

    // 改绑：session 改绑，Magi Agent 的项改用改绑的配置（本机配置时为 local）
    const kept = boundSession(rebound, 'auto');
    const keptLive = liveItemFor(kept.sessionId, rebound, 'exited');
    asAgent(keptLive.liveId, rebound);
    expect((await del(`/api/variants/${rebound}`, { rebindTo: flow.first })).statusCode).toBe(200);
    expect(sessionRow(kept.sessionId)).toMatchObject({
      variantId: flow.first,
      variantBinding: 'manual',
    });
    expect(liveRow(keptLive.liveId)).toMatchObject({ purpose: 'agent', agentConfig: flow.first });
    expect(fs.existsSync(kept.file)).toBe(true);
  });

  test('删除 workflow：全部 variant 按同一个选择处理，另删属于它的草稿、草稿目录与草稿的 Live 项；保留一行记录', async () => {
    const flow = await newFlow('whole', 1);
    const [second] = flow.others;
    if (second === undefined) throw new Error('没有派生出 variant');
    const s1 = boundSession(flow.first);
    const s2 = boundSession(second);
    const draftId = `d-20261014-${randomUUID().slice(0, 6)}`;
    const draftLive = liveItemFor(null, flow.first, 'exited');
    const draftDir = path.join(config.workflowDraftsDir, draftId);
    fs.mkdirSync(path.join(draftDir, 'src', 'skills'), { recursive: true });
    db.insert(schema.workflowDrafts)
      .values({
        id: draftId,
        mode: 'variant',
        workflowId: flow.id,
        baseVariantId: flow.first,
        requirement: '属于这个 workflow',
        liveId: draftLive.liveId,
        status: 'open',
      })
      .run();
    const plan = await get<Plan>(`/api/workflows/${flow.id}/delete-plan`);
    expect(plan.variants.map((v) => v.id).sort()).toEqual([flow.first, second].sort());
    expect(plan.sessions.count).toBe(2);
    expect(plan.drafts).toEqual([{ id: draftId, liveId: draftLive.liveId }]);
    expect(plan.dirs).toContain(draftDir);
    expect((await del(`/api/workflows/${flow.id}`, { rebindTo: null })).statusCode).toBe(200);
    for (const s of [s1, s2]) {
      expect(sessionRow(s.sessionId)).toMatchObject({ variantId: null, variantBinding: 'manual' });
    }
    expect(isDeleted(flow.first) && isDeleted(second)).toBe(true);
    expect(draftRow(draftId)).toBeUndefined();
    expect(fs.existsSync(draftDir)).toBe(false);
    expect(liveRow(draftLive.liveId)).toBeUndefined();
    // 列表中不再出现，id 不能再用
    expect((await get<{ id: string }[]>('/api/workflows')).map((w) => w.id)).not.toContain(flow.id);
    expect(workflowRecord(flow.id)?.deletedAt).not.toBeNull();
    const again = await post('/api/workflows', {
      id: flow.id,
      name: '再建',
      description: '',
      definition: { id: flow.id, name: '再建', stages: [{ id: 'step' }] },
    });
    expect(again.statusCode).toBe(409);
    expect(again.body).toContain('已删除的 workflow');
  });

  test('删除 workflow：由它的草稿保存出的 variant 保留一行，draft_id 置空（三个 variant，其中一个来自已保存的草稿）', async () => {
    const flow = await newFlow('saved-draft', 2);
    const [, saved] = flow.others;
    if (saved === undefined) throw new Error('没有派生出 variant');
    const draftId = `d-20261015-${randomUUID().slice(0, 6)}`;
    db.insert(schema.workflowDrafts)
      .values({
        id: draftId,
        mode: 'variant',
        workflowId: flow.id,
        baseVariantId: flow.first,
        requirement: '保存出一个 variant',
        status: 'saved',
        savedVariantId: saved,
      })
      .run();
    db.update(schema.variants).set({ draftId }).where(eq(schema.variants.id, saved)).run();
    const done = await del(`/api/workflows/${flow.id}`, 'delete');
    expect(done.statusCode, done.body).toBe(200);
    expect(draftRow(draftId)).toBeUndefined();
    expect(variantRow(saved)).toMatchObject({ draftId: null });
    expect(isDeleted(saved)).toBe(true);
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
  });

  test('外键路径：指向 variants、workflows、workflow_drafts、live_sessions 的每一条在删除 variant 与 workflow 后都干净', async () => {
    // 数据库中实际的外键（迁移建出的表）：新增的外键要在这里加上用例
    const tables = db.$client
      .prepare<[], { name: string }>("select name from sqlite_master where type = 'table'")
      .all()
      .map((t) => t.name);
    const targets = ['variants', 'workflows', 'workflow_drafts', 'live_sessions'];
    const foreignKeys = tables
      .flatMap((t) =>
        db.$client
          .prepare<[string], { table: string; from: string }>(
            'select "table", "from" from pragma_foreign_key_list(?)',
          )
          .all(t)
          .filter((k) => targets.includes(k.table))
          .map((k) => `${t}.${k.from} → ${k.table}`),
      )
      .sort();
    expect(foreignKeys).toEqual(
      [
        'analyses.analysis_variant_id → variants',
        'analyses.variant_id → variants',
        'batch_variants.variant_id → variants',
        'live_events.live_id → live_sessions',
        'live_processes.live_id → live_sessions',
        'live_processes.variant_id → variants',
        'magi_deploys.live_id → live_sessions',
        'runs.variant_id → variants',
        'sessions.live_id → live_sessions',
        'sessions.variant_id → variants',
        'variant_events.variant_id → variants',
        'variants.draft_id → workflow_drafts',
        'variants.parent_id → variants',
        'workflow_drafts.base_variant_id → variants',
        // 只有 lfg、ic 有这一行，它们不能删除（Contracts 24.1、29.1）
        'workflow_releases.workflow_id → workflows',
      ].sort(),
    );

    const flow = await newFlow('fk', 1);
    const [b] = flow.others;
    if (b === undefined) throw new Error('没有派生出 variant');
    const a = flow.first;
    // variants.parent_id：b 由 a 派生；另一个 workflow 中的 variant 也以 a 为 parent
    const other = await newFlow('fk-other', 0);
    db.update(schema.variants)
      .set({ parentId: a })
      .where(eq(schema.variants.id, other.first))
      .run();
    // runs.variant_id、batch_variants.variant_id，与 run 的 session（sessions.variant_id，绑定为 run）
    const runId = runOf(a, 'succeeded');
    const run = db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get();
    if (run === undefined) throw new Error(`run ${runId} 不存在`);
    db.insert(schema.batchVariants).values({ batchId: run.batchId, variantId: a }).run();
    const runSession = boundSession(a);
    db.update(schema.sessions)
      .set({ variantBinding: 'run', runId })
      .where(eq(schema.sessions.id, runSession.sessionId))
      .run();
    // analyses 的两列
    const analysisId = analysisOf(a, 'succeeded');
    db.update(schema.analyses)
      .set({ analysisVariantId: b })
      .where(eq(schema.analyses.id, analysisId))
      .run();
    // variant_events.variant_id
    for (const variantId of [a, b]) {
      db.insert(schema.variantEvents)
        .values({ variantId, at: new Date(), kind: 'rename', payload: { from: 'x', to: 'y' } })
        .run();
    }
    // 保留的 Live 项：进程用过 a（live_processes.variant_id），有事件（live_events.live_id）
    const kept = liveItemFor(null, a, 'exited');
    const liveEvent = (liveId: string) =>
      db
        .insert(schema.liveEvents)
        .values({ liveId, processId: null, at: new Date(), kind: 'rename', payload: {} })
        .run();
    liveEvent(kept.liveId);
    // 随 session 一起删除的 Live 项：sessions.live_id、live_processes.live_id、live_events.live_id、magi_deploys.live_id
    const s = boundSession(b);
    const sessionLive = liveItemFor(s.sessionId, b, 'exited');
    liveEvent(sessionLive.liveId);
    db.insert(schema.magiDeploys)
      .values({
        liveId: sessionLive.liveId,
        engine: 'claude',
        status: 'done',
        steps: [],
        logFile: path.join(work, 'deploy.log'),
        startedAt: new Date(),
      })
      .run();
    // workflow_drafts.base_variant_id 与 variants.draft_id：b 由属于这个 workflow 的草稿保存出，草稿有 Live 项
    const draftId = `d-20261015-${randomUUID().slice(0, 6)}`;
    const draftLive = liveItemFor(null, a, 'exited');
    db.insert(schema.workflowDrafts)
      .values({
        id: draftId,
        mode: 'variant',
        workflowId: flow.id,
        baseVariantId: a,
        requirement: '外键',
        liveId: draftLive.liveId,
        status: 'saved',
        savedVariantId: b,
      })
      .run();
    db.update(schema.variants).set({ draftId }).where(eq(schema.variants.id, b)).run();

    // 删除 variant b：session 与它的 Live 项（事件、进程、部署记录）一起删除；草稿保留，b 仍指向它
    const first = await del(`/api/variants/${b}`, 'delete');
    expect(first.statusCode, first.body).toBe(200);
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
    expect(sessionRow(s.sessionId)).toBeUndefined();
    expect(liveRow(sessionLive.liveId)).toBeUndefined();
    const deploys = db
      .select()
      .from(schema.magiDeploys)
      .where(eq(schema.magiDeploys.liveId, sessionLive.liveId))
      .all();
    expect(deploys).toEqual([]);
    expect(variantRow(b)).toMatchObject({ draftId, parentId: a });
    expect(draftRow(draftId)?.baseVariantId).toBe(a);

    // 删除 workflow：草稿与它的 Live 项删除，b 的 draft_id 置空；其余引用随保留的一行记录保留
    const second = await del(`/api/workflows/${flow.id}`, 'delete');
    expect(second.statusCode, second.body).toBe(200);
    expect(db.$client.pragma('foreign_key_check')).toEqual([]);
    expect(draftRow(draftId)).toBeUndefined();
    expect(liveRow(draftLive.liveId)).toBeUndefined();
    expect(variantRow(b)).toMatchObject({ draftId: null, parentId: a });
    expect(isDeleted(a) && isDeleted(b)).toBe(true);
    expect(variantRow(other.first)).toMatchObject({ parentId: a, deletedAt: null });
    expect(db.select().from(schema.runs).where(eq(schema.runs.id, runId)).get()?.variantId).toBe(a);
    expect(
      db
        .select()
        .from(schema.batchVariants)
        .where(eq(schema.batchVariants.batchId, run.batchId))
        .all(),
    ).toEqual([{ batchId: run.batchId, variantId: a }]);
    expect(sessionRow(runSession.sessionId)).toMatchObject({ variantId: a, variantBinding: 'run' });
    expect(
      db.select().from(schema.analyses).where(eq(schema.analyses.id, analysisId)).get(),
    ).toMatchObject({ variantId: a, analysisVariantId: b });
    const history = db
      .select({ variantId: schema.variantEvents.variantId })
      .from(schema.variantEvents)
      .where(inArray(schema.variantEvents.variantId, [a, b]))
      .all();
    expect(history.map((e) => e.variantId).sort()).toEqual([a, b].sort());
    expect(liveRow(kept.liveId)).toBeDefined();
    const keptProcesses = db
      .select()
      .from(schema.liveProcesses)
      .where(eq(schema.liveProcesses.liveId, kept.liveId))
      .all();
    expect(keptProcesses.map((p) => p.variantId)).toEqual([a]);
  });
});
