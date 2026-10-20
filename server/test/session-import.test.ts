import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import fastifyWebsocket from '@fastify/websocket';
import { eq } from 'drizzle-orm';
import Fastify from 'fastify';
import { afterAll, describe, expect, test } from 'vitest';
import { bindingRoutes } from '../src/api/bindings.js';
import { sessionActionRoutes } from '../src/api/session-actions.js';
import { sessionsRoutes } from '../src/api/sessions.js';
import { registerStageRoutes } from '../src/api/stages.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { requests, sessionImports, sessions, variants } from '../src/db/schema.js';
import { createSessionActions } from '../src/deletion/sessions.js';
import { ingestFile, initialParseState } from '../src/ingest/ingest.js';
import { configSourceDirs } from '../src/ingest/session-config.js';
import { tailSessions } from '../src/ingest/session-import.js';
import { createLive } from '../src/live/index.js';
import { createSettingsStore } from '../src/runs/settings.js';
import { createVariants } from '../src/variants/index.js';
import { testCodex } from './helpers/codex.js';
import { testRepos } from './helpers/local-repos.js';
import { sessionLines } from './helpers/session-copies.js';

// Contracts 25.1、25.4、25.5：上面三列（配置、项目、磁盘上的 session）、导入、清除后的增量导入、列表的范围、
// 本机配置的 session 的规则。来源目录是这个测试进程自己的（test/setup/data-dir.ts：Claude Code 的 projects 目录、
// CODEX_HOME、data/ 下的 variant 与草稿目录），不读写用户的 ~/.claude 与 ~/.codex。同一进程中别的测试也可能在这些
// 目录中放 session，这里只看自己建的（项目名带 tag）
const tag = randomUUID().slice(0, 8);
const dirs = configSourceDirs;
const work = path.join(config.repoRoot, '.work', 'test-session-import', tag);
const db = openDatabase(path.join(work, 'db.sqlite'), config.migrationsDir);
const variantsModule = createVariants({
  db,
  dataDir: config.dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});
const app = Fastify();
await app.register(fastifyWebsocket);
await app.register(sessionsRoutes, { prefix: '/api', db, dirs });
registerStageRoutes(app, db);
await app.register(bindingRoutes, { db, variants: variantsModule, dataDir: config.dataDir });
// 清除（Contracts 25.1）与 25.3 的动作共用路由；清除不调用 codex，也不删除 Live 项
const live = createLive({
  db,
  variants: variantsModule,
  settings: createSettingsStore(db),
  vaultDir: config.vaultDir,
  product: config.evalProduct,
  liveDir: path.join(work, 'live'),
  dataDir: config.dataDir,
  serverUrl: () => 'http://127.0.0.1:1',
  localHome: path.join(work, 'home'),
  repos: testRepos(),
  codex: testCodex(),
  claudeBin: config.claudeBin,
  autoStop: { idleMs: config.liveAutoStopMs, graceMs: config.liveStopGraceMs },
});
await app.register(sessionActionRoutes, {
  actions: createSessionActions({ db, live, codexBin: config.codexBin }),
});

// 工作目录（项目）：名字带 tag，与别的测试的区分
const cwdA = path.join(work, `alpha-${tag}`);
const cwdB = path.join(work, `beta-${tag}`);
const created: string[] = [];

// Claude Code 的 session（fixture「请记住暗号」的副本）放进一个 projects 目录下的项目目录
function claudeSession(projectsDir: string, slug: string, cwd: string) {
  const id = randomUUID();
  const dir = path.join(projectsDir, slug);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  fs.writeFileSync(file, sessionLines(id, cwd, ['还记得暗号吗？', '记得，青蛙-47。']));
  created.push(dir);
  return { id, file, dir };
}

// Codex 的 rollout（test/ingest-codex.test.ts 的真实样本）：换成新的 session id 与工作目录
const codexFixture = fs.readFileSync(
  path.join(
    import.meta.dirname,
    'fixtures/codex-rollouts/rollout-2026-10-04T20-22-00-01a106dd-2ba7-7e71-8490-0e170a634111.jsonl',
  ),
  'utf8',
);
function codexRollout(codexHome: string, sub: string, cwd: string) {
  const id = randomUUID();
  const [meta = '', ...rest] = codexFixture.split('\n');
  const first = JSON.parse(meta) as { payload: { id: string; session_id: string; cwd: string } };
  first.payload.id = id;
  first.payload.session_id = id;
  first.payload.cwd = cwd;
  const file = path.join(codexHome, sub, `rollout-2026-10-04T20-22-00-${id}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [JSON.stringify(first), ...rest].join('\n'));
  created.push(file);
  return { id, file };
}

// variant 的记录：只列没有删除的 variant 的配置
function variantRow(
  id: string,
  name: string,
  deleted: boolean,
  more: { workflowId?: string; storageId?: string; createdAt?: Date } = {},
) {
  db.insert(variants)
    .values({
      id,
      name,
      workflowId: more.workflowId ?? 'ic',
      storageId: more.storageId ?? null,
      baseCommit: '',
      skillsHash: '',
      version: '',
      deletedAt: deleted ? new Date() : null,
      ...(more.createdAt === undefined ? {} : { createdAt: more.createdAt }),
    })
    .run();
  created.push(path.join(dirs.variantsDir, more.storageId ?? id));
}

const localA1 = claudeSession(dirs.projectsDir, `-alpha-${tag}`, cwdA);
const localA2 = claudeSession(dirs.projectsDir, `-alpha-${tag}`, cwdA);
// 两个目录记下同一个工作目录（例如目录被改名）：合为一个项目
const localA3 = claudeSession(dirs.projectsDir, `-alpha-renamed-${tag}`, cwdA);
const localB = claudeSession(dirs.projectsDir, `-beta-${tag}`, cwdB);
const variantId = `v-import-${tag}`;
const deletedId = `v-import-del-${tag}`;
variantRow(variantId, `导入 ${tag}`, false);
variantRow(deletedId, `已删 ${tag}`, true);
const inVariant = claudeSession(
  path.join(dirs.variantsDir, variantId, 'home', 'claude', 'projects'),
  `-alpha-${tag}`,
  cwdA,
);
const inDeleted = claudeSession(
  path.join(dirs.variantsDir, deletedId, 'home', 'claude', 'projects'),
  `-alpha-${tag}`,
  cwdA,
);
// 16.4 的迁移拆出的一对：同一时刻建出的 lfg 与 ic 共用 lfg 的配置目录（按 id 排序 ic 在前，是最早建的）；
// 目录中一个 session 绑定 lfg，一个没有绑定。另有一个还没有 session 的 lfg variant
const pairIc = `v-pair-a-${tag}`;
const pairLfg = `v-pair-b-${tag}`;
const emptyLfg = `v-empty-${tag}`;
const pairAt = new Date('2026-10-01T00:00:00Z');
variantRow(pairIc, `基线 ${tag}`, false, { storageId: pairLfg, createdAt: pairAt });
variantRow(pairLfg, `基线 ${tag}`, false, {
  workflowId: 'lfg',
  storageId: pairLfg,
  createdAt: pairAt,
});
variantRow(emptyLfg, `空 ${tag}`, false, { workflowId: 'lfg' });
const pairProjects = path.join(dirs.variantsDir, pairLfg, 'home', 'claude', 'projects');
const pairBound = claudeSession(pairProjects, `-alpha-${tag}`, cwdA);
const pairFree = claudeSession(pairProjects, `-alpha-${tag}`, cwdA);
const draftDir = path.join(dirs.draftsDir, `d-${tag}`);
created.push(draftDir);
const design = claudeSession(path.join(draftDir, 'claude-config', 'projects'), `-d-${tag}`, cwdB);
const codexA = codexRollout(dirs.codexHome, 'sessions/2026/10/04', cwdA);
const codexArchived = codexRollout(dirs.codexHome, 'archived_sessions', cwdA);
const codexB = codexRollout(dirs.codexHome, 'sessions/2026/10/04', cwdB);
const codexDesign = codexRollout(path.join(draftDir, 'codex-home'), 'sessions/2026/10/04', cwdB);

afterAll(async () => {
  await live.shutdown();
  await app.close();
  db.$client.close();
  for (const p of created) fs.rmSync(p, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

async function get<T>(url: string) {
  const response = await app.inject({ method: 'GET', url });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
}
async function post(url: string, payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url, payload });
}

interface Project {
  cwd: string;
  name: string;
  sessionCount: number;
  importedCount: number;
}
interface ProjectPage {
  projects: Project[];
  total: number;
  page: number;
  pageSize: number;
}
interface DiskSession {
  id: string;
  file: string;
  title: string | null;
  startedAt: string;
  size: number;
  imported: boolean;
  liveId: string | null;
}
interface DiskPage {
  sessions: DiskSession[];
  total: number;
}

const projects = (engine: string, configId: string, query = `q=${tag}`) =>
  get<ProjectPage>(
    `/api/session-import/projects?engine=${engine}&config=${encodeURIComponent(configId)}&${query}`,
  );
const disk = (engine: string, configId: string, cwd: string, query = '') =>
  get<DiskPage>(
    `/api/session-import/sessions?engine=${engine}&config=${encodeURIComponent(configId)}&cwd=${encodeURIComponent(cwd)}&${query}`,
  );
const ids = async (query: string) =>
  (await get<{ sessions: { id: string }[] }>(`/api/sessions?${query}`)).sessions
    .map((s) => s.id)
    .sort();
const listed = async (engine: string) => ids(`engine=${engine}&limit=500`);

describe('Claude Code：三列', () => {
  interface Config {
    id: string;
    label: string;
    workflow: { id: string; name: string } | null;
    sessionCount: number;
  }
  const claudeConfigs = async () =>
    (await get<{ configs: Config[] }>('/api/session-import/configs?engine=claude')).configs;

  test('第一列：本机配置、全部没有删除的 variant（按 workflow 分组，显示自己的名字）、设计与优化', async () => {
    const configs = await claudeConfigs();
    expect(configs[0]).toMatchObject({ id: 'local', label: '本机配置', workflow: null });
    expect(configs[0]?.sessionCount).toBeGreaterThanOrEqual(4);
    expect(configs.find((c) => c.id === `variant:${variantId}`)).toEqual({
      id: `variant:${variantId}`,
      label: `导入 ${tag}`,
      workflow: { id: 'ic', name: 'ic' },
      sessionCount: 1,
    });
    // 没有 session 的也列出
    expect(configs.find((c) => c.id === `variant:${emptyLfg}`)).toEqual({
      id: `variant:${emptyLfg}`,
      label: `空 ${tag}`,
      workflow: { id: 'lfg', name: 'lfg' },
      sessionCount: 0,
    });
    expect(configs.some((c) => c.id === `variant:${deletedId}`)).toBe(false);
    expect(configs.at(-1)).toMatchObject({ id: 'design', label: '设计与优化', workflow: null });
    // 同一 workflow 的 variant 相邻（组内按创建时间）
    const variantWorkflows = configs.flatMap((c) => (c.workflow === null ? [] : [c.workflow.id]));
    const runs = variantWorkflows.filter((w, i) => w !== variantWorkflows[i - 1]);
    expect(new Set(runs).size).toBe(runs.length);
    const lfgIds = configs.filter((c) => c.workflow?.id === 'lfg').map((c) => c.id);
    expect(lfgIds.indexOf(`variant:${pairLfg}`)).toBeLessThan(
      lfgIds.indexOf(`variant:${emptyLfg}`),
    );
  });

  test('第一列：共用配置目录的 lfg 与 ic，目录中的 session 按绑定归入各自的 variant，没有绑定的归入最早建的', async () => {
    ingestFile(db, pairBound.file);
    db.update(sessions)
      .set({ variantId: pairLfg, variantBinding: 'run' })
      .where(eq(sessions.id, pairBound.id))
      .run();
    const configs = await claudeConfigs();
    expect(configs.find((c) => c.id === `variant:${pairLfg}`)).toMatchObject({
      label: `基线 ${tag}`,
      workflow: { id: 'lfg', name: 'lfg' },
      sessionCount: 1,
    });
    expect(configs.find((c) => c.id === `variant:${pairIc}`)).toMatchObject({
      label: `基线 ${tag}`,
      workflow: { id: 'ic', name: 'ic' },
      sessionCount: 1,
    });
    const third = async (variant: string) =>
      (await disk('claude', `variant:${variant}`, cwdA)).sessions.map((s) => s.id);
    expect(await third(pairLfg)).toEqual([pairBound.id]);
    expect(await third(pairIc)).toEqual([pairFree.id]);

    // 管理表格的配置筛选与每行的配置与第一列相同
    ingestFile(db, pairFree.file);
    expect(await ids(`config=variant:${pairLfg}`)).toEqual([pairBound.id]);
    expect(await ids(`config=variant:${pairIc}`)).toEqual([pairFree.id]);
    expect(await ids(`config=variant:${emptyLfg}`)).toEqual([]);
    const summary = async (id: string) =>
      get<{ config: string | null; workflows: string[] }>(`/api/sessions/${id}`);
    expect(await summary(pairBound.id)).toMatchObject({
      config: `variant:${pairLfg}`,
      workflows: ['lfg'],
    });
    expect(await summary(pairFree.id)).toMatchObject({
      config: `variant:${pairIc}`,
      workflows: ['ic'],
    });
  });

  test('第二列：按工作目录合并，数目与已导入的数目；搜索不分大小写，分页', async () => {
    const local = await projects('claude', 'local');
    expect(local).toMatchObject({ total: 2, page: 1, pageSize: 50 });
    expect(local.projects).toEqual([
      { cwd: cwdA, name: `alpha-${tag}`, sessionCount: 3, importedCount: 0 },
      { cwd: cwdB, name: `beta-${tag}`, sessionCount: 1, importedCount: 0 },
    ]);
    expect((await projects('claude', 'local', `q=BETA-${tag.toUpperCase()}`)).projects).toEqual([
      expect.objectContaining({ cwd: cwdB }),
    ]);
    // 按路径搜索
    expect((await projects('claude', 'local', `q=${encodeURIComponent(cwdA)}`)).total).toBe(1);
    const second = await projects('claude', 'local', `q=${tag}&page=2&pageSize=1`);
    expect([second.total, second.projects.map((p) => p.cwd)]).toEqual([2, [cwdB]]);
    expect((await projects('claude', `variant:${variantId}`)).projects).toEqual([
      { cwd: cwdA, name: `alpha-${tag}`, sessionCount: 1, importedCount: 0 },
    ]);
    const unknown = await app.inject({
      method: 'GET',
      url: `/api/session-import/projects?config=variant:${deletedId}`,
    });
    expect(unknown.statusCode).toBe(400);
  });

  test('第三列：项目在磁盘上的 session（标题、开始时间、大小），按开始时间与 id 倒序；搜索 id 与标题，分页', async () => {
    const all = await disk('claude', 'local', cwdA);
    expect(all.total).toBe(3);
    expect(all.sessions.map((s) => s.id)).toEqual(
      [localA1, localA2, localA3]
        .map((s) => s.id)
        .sort()
        .reverse(),
    );
    const first = all.sessions.find((s) => s.id === localA1.id);
    expect(first).toMatchObject({
      file: localA1.file,
      size: fs.statSync(localA1.file).size,
      imported: false,
      liveId: null,
    });
    expect(first?.title).toBeTruthy();
    const byId = await disk('claude', 'local', cwdA, `q=${localA2.id.slice(0, 8).toUpperCase()}`);
    expect(byId.sessions.map((s) => s.id)).toEqual([localA2.id]);
    expect(
      (await disk('claude', 'local', cwdA, `q=${encodeURIComponent(first?.title ?? '')}`)).total,
    ).toBe(3);
    const page2 = await disk('claude', 'local', cwdA, 'page=2&pageSize=2');
    expect([page2.total, page2.sessions.length]).toEqual([3, 1]);
  });
});

describe('导入与清除', () => {
  test('导入两个后它们进入管理表格、第三列标为已导入；同一个项目中的其他 session 不导入', async () => {
    const response = await post('/api/session-import', {
      engine: 'claude',
      files: [localA1.file, localB.file],
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      sessions: [
        { id: localA1.id, file: localA1.file },
        { id: localB.id, file: localB.file },
      ],
    });
    const list = await listed('claude');
    expect(list).toEqual(expect.arrayContaining([localA1.id, localB.id]));
    expect(list).not.toContain(localA2.id);
    const column = await disk('claude', 'local', cwdA);
    expect(column.sessions.filter((s) => s.imported).map((s) => s.id)).toEqual([localA1.id]);
    // 已导入的标题取 dashboard 中的，与磁盘上读出的相同；开始时间也相同
    const summary = await get<{ title: string; startedAt: string }>(`/api/sessions/${localA1.id}`);
    expect(column.sessions.find((s) => s.id === localA1.id)).toMatchObject({
      title: summary.title,
      startedAt: summary.startedAt,
    });
    expect((await projects('claude', 'local')).projects[0]?.importedCount).toBe(1);
    // 再导入一次不报错
    expect((await post('/api/session-import', { files: [localA1.file] })).statusCode).toBe(200);
    // 配置以外的文件 400，原文列出
    const outside = await post('/api/session-import', { files: [inDeleted.file] });
    expect(outside.statusCode).toBe(400);
    expect(outside.json<{ message: string }>().message).toContain(inDeleted.file);
    expect(
      db.select().from(sessionImports).where(eq(sessionImports.sessionId, localA1.id)).get(),
    ).toMatchObject({ engine: 'claude', filePath: localA1.file, clearedAt: null });
  });

  test('增量导入：dashboard 自己的配置中新出现的自动导入（已删除的 variant 的不导入），本机没有导入的不导入；已导入的文件变长时导入新增的部分', async () => {
    await tailSessions(db, dirs);
    const list = await listed('claude');
    expect(list).toEqual(expect.arrayContaining([inVariant.id, design.id]));
    expect(list).not.toContain(inDeleted.id);
    expect(list).not.toContain(localA2.id);
    expect(await listed('codex')).toEqual(expect.arrayContaining([codexDesign.id]));
    expect(await listed('codex')).not.toContain(codexA.id);

    const before = (await get<{ requestCount: number }>(`/api/sessions/${localA1.id}`))
      .requestCount;
    const more = sessionLines(localA1.id, cwdA, [
      '还记得暗号吗？',
      '记得，青蛙-47。',
      '再说一次？',
      '青蛙-47。',
    ])
      .split('\n')
      .slice(-3)
      .join('\n');
    fs.appendFileSync(localA1.file, more);
    expect(await tailSessions(db, dirs)).toBeGreaterThanOrEqual(1);
    expect((await get<{ requestCount: number }>(`/api/sessions/${localA1.id}`)).requestCount).toBe(
      before + 1,
    );
  });

  test('清除：只记下清除时间，dashboard 中的数据与磁盘上的文件都保留；之后照常增量导入但不列出，重新导入后又出现', async () => {
    const plan = await get<{
      sessions: { files: string[] }[];
      liveItems: unknown[];
      blockers: unknown[];
    }>(`/api/sessions/action-plan?action=clear&ids=${localA1.id},${inVariant.id}`);
    expect(plan).toMatchObject({
      sessions: [{ files: [] }, { files: [] }],
      liveItems: [],
      blockers: [],
    });
    const requestsBefore = db
      .select()
      .from(requests)
      .where(eq(requests.sessionId, localA1.id))
      .all().length;
    const cleared = await post('/api/sessions/clear', { ids: [localA1.id, inVariant.id] });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(fs.existsSync(localA1.file) && fs.existsSync(inVariant.file)).toBe(true);
    const list = await listed('claude');
    expect(list).not.toContain(localA1.id);
    expect(list).not.toContain(inVariant.id);
    expect(db.select().from(requests).where(eq(requests.sessionId, localA1.id)).all()).toHaveLength(
      requestsBefore,
    );
    expect(
      db.select().from(sessionImports).where(eq(sessionImports.sessionId, localA1.id)).get()
        ?.clearedAt,
    ).toBeInstanceOf(Date);
    expect((await disk('claude', 'local', cwdA)).sessions.every((s) => !s.imported)).toBe(true);
    expect((await projects('claude', 'local')).projects[0]?.importedCount).toBe(0);

    // 文件变长、增量导入：清除的照常导入新增的部分，仍不列出（variant 配置下的也一样）
    const before = (await get<{ requestCount: number }>(`/api/sessions/${localA1.id}`))
      .requestCount;
    const more = sessionLines(localA1.id, cwdA, ['又一轮', '好的'])
      .split('\n')
      .slice(-3)
      .join('\n');
    fs.appendFileSync(localA1.file, more);
    await tailSessions(db, dirs);
    expect((await get<{ requestCount: number }>(`/api/sessions/${localA1.id}`)).requestCount).toBe(
      before + 1,
    );
    expect(await listed('claude')).not.toContain(localA1.id);
    expect(await listed('claude')).not.toContain(inVariant.id);

    // 从上面重新导入后又出现
    expect((await post('/api/session-import', { files: [localA1.file] })).statusCode).toBe(200);
    expect(await listed('claude')).toContain(localA1.id);
    expect(
      db.select().from(sessionImports).where(eq(sessionImports.sessionId, localA1.id)).get()
        ?.clearedAt,
    ).toBeNull();
  });

  test('watcher 照常导入清除了的 session，不改变清除（新的进程启动时才重新进入管理表格）', async () => {
    expect(await listed('claude')).not.toContain(inVariant.id);
    ingestFile(db, inVariant.file);
    await tailSessions(db, dirs);
    expect(await listed('claude')).not.toContain(inVariant.id);
  });

  test('run 的 session 也可以清除', async () => {
    expect((await post('/api/session-import', { files: [inVariant.file] })).statusCode).toBe(200);
    db.update(sessions).set({ variantBinding: 'run' }).where(eq(sessions.id, inVariant.id)).run();
    const plan = await get<{ blockers: unknown[] }>(
      `/api/sessions/action-plan?action=clear&ids=${inVariant.id}`,
    );
    expect(plan.blockers).toEqual([]);
    const cleared = await post('/api/sessions/clear', { ids: [inVariant.id] });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(await listed('claude')).not.toContain(inVariant.id);
    expect(db.select().from(sessions).where(eq(sessions.id, inVariant.id)).get()).toBeDefined();
    expect((await post('/api/session-import', { files: [inVariant.file] })).statusCode).toBe(200);
    expect(await listed('claude')).toContain(inVariant.id);
  });
});

describe('Codex：三列与导入', () => {
  test('本机的按 session_meta 的 cwd 列出项目（含已归档的）；导入后 archived_sessions 中的为已归档，默认不列出', async () => {
    const { configs } = await get<{ configs: { id: string }[] }>(
      '/api/session-import/configs?engine=codex',
    );
    expect(configs.map((c) => c.id)).toEqual(['local', 'design']);
    expect((await projects('codex', 'local')).projects).toEqual([
      { cwd: cwdA, name: `alpha-${tag}`, sessionCount: 2, importedCount: 0 },
      { cwd: cwdB, name: `beta-${tag}`, sessionCount: 1, importedCount: 0 },
    ]);
    const column = await disk('codex', 'local', cwdA);
    expect(column.sessions.map((s) => s.id).sort()).toEqual([codexA.id, codexArchived.id].sort());
    expect(column.sessions.every((s) => s.title !== null)).toBe(true);
    const response = await post('/api/session-import', {
      engine: 'codex',
      files: [codexA.file, codexArchived.file],
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(await ids(`engine=codex&config=local`)).toEqual(expect.arrayContaining([codexA.id]));
    expect(await ids(`engine=codex&config=local&archived=true`)).toEqual(
      expect.arrayContaining([codexArchived.id]),
    );
    expect(await listed('codex')).not.toContain(codexB.id);
    // 第三列的开始时间是 rollout 中第一条记录的时间，与导入后的相同
    const imported = await get<{ startedAt: string }>(`/api/sessions/${codexA.id}`);
    expect(
      (await disk('codex', 'local', cwdA)).sessions.find((s) => s.id === codexA.id)?.startedAt,
    ).toBe(imported.startedAt);
    // Claude Code 的文件不能按 Codex 导入
    expect(
      (await post('/api/session-import', { engine: 'codex', files: [localA2.file] })).statusCode,
    ).toBe(400);
    // 本机的 Codex session 同样不绑定、不划分阶段
    expect(
      (await app.inject({ method: 'GET', url: `/api/sessions/${codexA.id}/stages` })).statusCode,
    ).toBe(404);
  });

  test('在 dashboard 之外归档（rollout 移进 archived_sessions）：增量导入按 session id 找到它，记为已归档', async () => {
    const archivedFile = path.join(dirs.codexHome, 'archived_sessions', path.basename(codexA.file));
    fs.renameSync(codexA.file, archivedFile);
    created.push(archivedFile);
    await tailSessions(db, dirs);
    expect(db.select().from(sessions).where(eq(sessions.id, codexA.id)).get()).toMatchObject({
      filePath: archivedFile,
      archivedAt: expect.any(Date) as Date,
    });
    expect(await ids('engine=codex&config=local&archived=true')).toEqual(
      expect.arrayContaining([codexA.id]),
    );
  });
});

describe('列表的范围与本机配置的规则', () => {
  test('GET /api/sessions 的 config：本机、variant、设计与优化；未知的配置 400', async () => {
    expect(await ids('config=local')).toEqual(expect.arrayContaining([localA1.id, localB.id]));
    expect(await ids(`config=variant:${variantId}`)).toEqual([inVariant.id]);
    expect(await ids('config=design')).toEqual(expect.arrayContaining([design.id]));
    const unknown = await app.inject({
      method: 'GET',
      url: '/api/sessions?config=variant:x&engine=codex',
    });
    expect(unknown.statusCode).toBe(400);
  });

  test('列表的 config、purpose、workflow 与 variant：本机的与设计的没有 workflow，variant 配置下的取所属 variant 与它的 workflow', async () => {
    const { sessions: list } = await get<{
      sessions: {
        id: string;
        config: string;
        purpose: string | null;
        workflows: string[];
        variant: { id: string } | null;
      }[];
    }>('/api/sessions?engine=claude&limit=500');
    const byId = new Map(list.map((s) => [s.id, s]));
    expect(byId.get(localA1.id)).toMatchObject({
      config: 'local',
      purpose: null,
      workflows: [],
      variant: null,
    });
    expect(byId.get(inVariant.id)).toMatchObject({
      config: `variant:${variantId}`,
      workflows: ['ic'],
      variant: { id: variantId },
    });
    expect(byId.get(design.id)).toMatchObject({
      config: 'design',
      purpose: 'design',
      workflows: [],
    });
  });

  test('本机配置的 session：没有阶段（404 说明），不能手动绑定（409）', async () => {
    const stages = await app.inject({ method: 'GET', url: `/api/sessions/${localA1.id}/stages` });
    expect(stages.statusCode).toBe(404);
    expect(stages.json<{ error: string }>().error).toContain('属于本机配置，不划分阶段');
    const bind = await app.inject({
      method: 'PUT',
      url: `/api/sessions/${localA1.id}/binding`,
      payload: { variantId },
    });
    expect(bind.statusCode).toBe(409);
    expect(bind.body).toContain('本机配置的 session 不绑定 variant');
    // variant 配置下的 session 照常有阶段
    expect(
      (await app.inject({ method: 'GET', url: `/api/sessions/${inVariant.id}/stages` })).statusCode,
    ).toBe(200);
  });

  test('管理表格的分页：page 与 pageSize，total 为范围与搜索内的总数；与 cursor 同时传时 400', async () => {
    expect(
      (await post('/api/session-import', { files: [localA2.file, localA3.file] })).statusCode,
    ).toBe(200);
    interface List {
      sessions: { id: string }[];
      total: number;
    }
    const scope = `engine=claude&config=local&q=${tag}`;
    // cwd 中带 tag：本机配置下这个测试导入的 4 个
    const one = await get<List>(`/api/sessions?${scope}&page=1&pageSize=3`);
    const two = await get<List>(`/api/sessions?${scope}&page=2&pageSize=3`);
    expect([one.total, one.sessions.length, two.total, two.sessions.length]).toEqual([4, 3, 4, 1]);
    const byCursor = await get<List>(`/api/sessions?${scope}&limit=4`);
    expect(byCursor.sessions.map((s) => s.id)).toEqual(
      [...one.sessions, ...two.sessions].map((s) => s.id),
    );
    const both = await app.inject({ method: 'GET', url: `/api/sessions?${scope}&page=1&cursor=x` });
    expect(both.statusCode).toBe(400);
  });

  test('idsOnly：范围（引擎、配置、已归档）与搜索内全部的 id，顺序与表格相同；与分页参数同时传时 400', async () => {
    expect(
      (await post('/api/session-import', { files: [localA2.file, localA3.file] })).statusCode,
    ).toBe(200);
    interface Ids {
      ids: string[];
      total: number;
    }
    const scope = `engine=claude&config=local&q=${tag}`;
    const all = await get<Ids>(`/api/sessions?${scope}&idsOnly=true`);
    const pages = await Promise.all(
      ['1', '2'].map((n) =>
        get<{ sessions: { id: string }[] }>(`/api/sessions?${scope}&page=${n}&pageSize=3`),
      ),
    );
    expect(all).toEqual({ ids: pages.flatMap((p) => p.sessions.map((s) => s.id)), total: 4 });
    // 搜索 session id、配置筛选与 Codex 的已归档：与列表相同
    expect(
      await get<Ids>(`/api/sessions?engine=claude&q=${localA2.id.slice(0, 8)}&idsOnly=true`),
    ).toEqual({ ids: [localA2.id], total: 1 });
    expect(
      (await get<Ids>(`/api/sessions?config=variant:${variantId}&idsOnly=true`)).ids.sort(),
    ).toEqual(await ids(`config=variant:${variantId}`));
    for (const archived of ['true', 'false']) {
      const query = `engine=codex&config=local&archived=${archived}`;
      expect((await get<Ids>(`/api/sessions?${query}&idsOnly=true`)).ids.sort()).toEqual(
        await ids(`${query}&limit=500`),
      );
    }
    for (const paging of ['page=1', 'pageSize=50', 'limit=50', 'cursor=x']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/sessions?${scope}&idsOnly=true&${paging}`,
      });
      expect(response.statusCode, paging).toBe(400);
      expect(response.json<{ error: string }>().error).toBe('idsOnly 与分页参数不能同时使用');
    }
  });
});

// 迁移 0023 与 0024 在已有记录上运行：只用到第 n 个迁移的目录（仓库的迁移目录的副本，journal 截到第 n 个）
function migrationsUpTo(tagName: string): string {
  const dir = path.join(work, `migrations-${tagName}`);
  fs.cpSync(config.migrationsDir, dir, { recursive: true });
  const journalFile = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(fs.readFileSync(journalFile, 'utf8')) as {
    entries: { tag: string }[];
  };
  const at = journal.entries.findIndex((e) => e.tag === tagName);
  if (at < 0) throw new Error(`没有迁移 ${tagName}`);
  journal.entries = journal.entries.slice(0, at + 1);
  fs.writeFileSync(journalFile, JSON.stringify(journal, null, 2));
  return dir;
}

test('迁移 0023 清除本机来源下的自动与手动绑定；0024 把已有的 session 全部记为已导入、去掉来源', () => {
  const file = path.join(work, 'migration.sqlite');
  const before = openDatabase(file, migrationsUpTo('0023_sessions-engine'));
  const insertSource = before.$client.prepare<[string, string | null], { id: number }>(
    'insert into sources (path, variant, enabled) values (?, ?, 1) returning id',
  );
  const local = insertSource.get('/local', null)?.id;
  const inVariantSource = insertSource.get('/variant', 'v1')?.id;
  // 只写 0023 时已有的列（drizzle 的 insert 按最新的 schema 写全部列）
  before.$client.exec(
    "insert into variants (id, name, workflow_id, base_commit, skills_hash, version) values ('v1', 'v1', 'ic', '', '', '')",
  );
  const insertSession = before.$client.prepare(
    `insert into sessions (id, source_id, file_path, started_at, ended_at, variant_id, variant_binding, parse_state, created_at)
     values (?, ?, ?, 0, 0, 'v1', ?, ?, 1000)`,
  );
  for (const [id, sourceId, binding] of [
    ['auto-local', local, 'auto'],
    ['manual-local', local, 'manual'],
    ['run-local', local, 'run'],
    ['auto-variant', inVariantSource, 'auto'],
  ] as const)
    insertSession.run(id, sourceId, `/${id}.jsonl`, binding, JSON.stringify(initialParseState()));
  // 0023 的最后一句（数据的清除）在已有记录上再执行一次
  const sql = fs.readFileSync(path.join(config.migrationsDir, '0023_sessions-engine.sql'), 'utf8');
  const update = sql.split('--> statement-breakpoint').at(-1)?.trim() ?? '';
  expect(update.startsWith('-- 本机配置的 session 不绑定 variant')).toBe(true);
  before.$client.exec(update);
  before.$client.close();

  const migrated = openDatabase(file, config.migrationsDir);
  const bindings = migrated
    .select({ id: sessions.id, variantId: sessions.variantId, binding: sessions.variantBinding })
    .from(sessions)
    .all();
  expect(bindings.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
    { id: 'auto-local', variantId: null, binding: null },
    { id: 'auto-variant', variantId: 'v1', binding: 'auto' },
    { id: 'manual-local', variantId: null, binding: null },
    { id: 'run-local', variantId: 'v1', binding: 'run' },
  ]);
  expect(
    migrated
      .select()
      .from(sessionImports)
      .all()
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId)),
  ).toEqual(
    ['auto-local', 'auto-variant', 'manual-local', 'run-local'].map((id) => ({
      sessionId: id,
      engine: 'claude',
      filePath: `/${id}.jsonl`,
      importedAt: new Date(1000),
      clearedAt: null,
    })),
  );
  expect(
    migrated.$client.prepare("select name from sqlite_master where name = 'sources'").all(),
  ).toEqual([]);
  migrated.$client.close();
});
