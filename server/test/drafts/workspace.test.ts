import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventSource } from 'eventsource';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { codexStandIn, makeSkillSources } from '../helpers/codex-skills.js';

// 基础档（Contracts 26.4）：设计与优化会话的 workflow 面板的只读接口——文件树与标记、读文件、相对底子的 diff、越界拒绝、
// workflow.yaml 解析失败时的返回，以及监视的事件与释放。测试代码直接改草稿目录中的文件代替 agent，Codex 是替身命令，
// skill 来源是 .work/ 下的本地 git 仓库
const work = path.resolve(import.meta.dirname, '../../../.work/test-workspace', randomUUID());
const sources = makeSkillSources(path.join(work, 'skill-sources'));
process.env.WFD_CODEX_SKILL_SOURCES = JSON.stringify(sources);
process.env.WFD_CODEX_BIN = codexStandIn;

const { buildApp } = await import('../../src/api/app.js');
const { config } = await import('../../src/config.js');
const { openDatabase } = await import('../../src/db/index.js');

const dbFile = path.join(config.repoRoot, '.work', 'test-db', `${randomUUID()}.sqlite`);
const db = openDatabase(dbFile, config.migrationsDir);
const app = await buildApp({
  db,
  sseHeartbeatMs: config.sseHeartbeatMs,
  logger: false,
  tasksDir: config.tasksDir,
});
const marker = randomUUID().slice(0, 6);
const flowId = `ws-${marker}`;
let base = '';

interface Draft {
  id: string;
  status: string;
  error: string | null;
  steps: { status: string }[];
  liveId: string | null;
  dir: string;
}
interface Workspace {
  draftId: string;
  mode: string;
  analysisId: string | null;
  root: string;
  base: { id: string; name: string } | null;
  workflow:
    | { definition: { id: string }; stages: { id: string; entry: boolean; status: string }[] }
    | { error: string };
  files: { path: string; status: string; mtimeMs: number | null }[];
}
interface Diagnostics {
  workspace: { watchers: number; connections: number };
}

const get = async <T>(url: string) => {
  const response = await app.inject({ method: 'GET', url });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<T>();
};
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
const skillMd = (name: string, body: string) =>
  `---\nname: ${name}\ndescription: ${name} 阶段\n---\n\n${body}\n`;

async function openDraft(): Promise<Draft> {
  const created = await app.inject({
    method: 'POST',
    url: '/api/workflow-drafts',
    payload: {
      mode: 'variant',
      engine: 'codex',
      workflowId: flowId,
      requirement: '改 scan',
      baseVariantId: base,
    },
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

// 结束替身 Codex 进程，之后才能关闭或删除这一项
async function stopItem(liveId: string) {
  await app.inject({ method: 'POST', url: `/api/live/${liveId}/stop` });
  for (;;) {
    const item = await get<{ status: string; title: string }>(`/api/live/${liveId}`);
    if (item.status !== 'running') return item;
    await sleep(100);
  }
}

// 一个打开着的面板：SSE 连接收到的事件
function openEvents(baseUrl: string, liveId: string) {
  const received: { type: string; data: Record<string, unknown>; at: number }[] = [];
  const source = new EventSource(`${baseUrl}/api/live/${liveId}/workspace/events`);
  const ready = new Promise<void>((resolve, reject) => {
    source.addEventListener('ready', () => {
      resolve();
    });
    source.addEventListener('error', (event) => {
      reject(new Error(`SSE 出错：${String(event.message)}`));
    });
  });
  for (const type of ['changed', 'closed', 'failed']) {
    source.addEventListener(type, (event) => {
      received.push({
        type,
        data: JSON.parse(String(event.data)) as Record<string, unknown>,
        at: performance.now(),
      });
    });
  }
  const next = async (type: string, from: number) => {
    const deadline = performance.now() + 5_000;
    for (;;) {
      const found = received.slice(from).find((e) => e.type === type);
      if (found !== undefined) return found;
      if (performance.now() > deadline) throw new Error(`5 秒内没有收到 ${type}`);
      await sleep(20);
    }
  };
  return { source, ready, received, next };
}

let baseUrl = '';

beforeAll(async () => {
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('没有监听 TCP 端口');
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
  // 从空白新建的 workflow 与它的初稿（入口 ws-…、小阶段 scan 与 report 的骨架）
  const made = await app.inject({
    method: 'POST',
    url: '/api/workflows',
    payload: {
      id: flowId,
      name: `面板 ${marker}`,
      description: '',
      definition: {
        id: flowId,
        name: `面板 ${marker}`,
        stages: [{ id: 'scan' }, { id: 'report' }],
      },
    },
  });
  expect(made.statusCode, made.body).toBe(201);
  const list = await get<{ id: string; workflowId: string }[]>('/api/variants');
  base = list.find((v) => v.workflowId === flowId)?.id ?? '';
  expect(base).not.toBe('');
});

afterAll(async () => {
  await app.close();
  db.$client.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

describe('设计会话的 workflow 面板', { timeout: 60_000 }, () => {
  let draft: Draft;
  let liveId = '';
  const skill = (file: string) => path.join(draft.dir, 'src/skills', file);

  beforeAll(async () => {
    draft = await openDraft();
    liveId = draft.liveId ?? '';
  });

  test('文件树与标记：刚准备好时都未变；改、加、删之后文件与节点的标记', async () => {
    const fresh = await get<Workspace>(`/api/live/${liveId}/workspace`);
    expect(fresh).toMatchObject({
      draftId: draft.id,
      mode: 'variant',
      analysisId: null,
      root: 'src/skills',
      base: { id: base, name: '初稿' },
    });
    expect(fresh.files.map((f) => [f.path, f.status])).toEqual([
      ['skills/report/SKILL.md', 'unchanged'],
      ['skills/scan/SKILL.md', 'unchanged'],
      [`skills/${flowId}/SKILL.md`, 'unchanged'],
    ]);
    expect(fresh.files.every((f) => typeof f.mtimeMs === 'number')).toBe(true);
    expect('stages' in fresh.workflow && fresh.workflow.stages).toEqual([
      { id: flowId, entry: true, status: 'unchanged' },
      { id: 'scan', entry: false, status: 'unchanged' },
      { id: 'report', entry: false, status: 'unchanged' },
    ]);

    fs.writeFileSync(skill('scan/SKILL.md'), skillMd('scan', '先列出要扫描的目录。'));
    fs.writeFileSync(skill('scan/notes.md'), '# 笔记\n');
    fs.rmSync(skill('report'), { recursive: true });
    fs.mkdirSync(skill('extra'));
    fs.writeFileSync(skill('extra/SKILL.md'), skillMd('extra', '另加的 skill。'));
    // 符号链接不列出
    fs.symlinkSync(path.join(draft.dir, 'PLATFORM.md'), skill('scan/link.md'));
    const changed = await get<Workspace>(`/api/live/${liveId}/workspace`);
    expect(changed.files.map((f) => [f.path, f.status, f.mtimeMs === null])).toEqual([
      ['skills/extra/SKILL.md', 'added', false],
      ['skills/report/SKILL.md', 'removed', true],
      ['skills/scan/SKILL.md', 'modified', false],
      ['skills/scan/notes.md', 'added', false],
      [`skills/${flowId}/SKILL.md`, 'unchanged', false],
    ]);
    expect('stages' in changed.workflow && changed.workflow.stages).toEqual([
      { id: flowId, entry: true, status: 'unchanged' },
      { id: 'scan', entry: false, status: 'modified' },
      { id: 'report', entry: false, status: 'missing' },
    ]);
  });

  test('读文件与 diff：工作目录中的内容、已删除的为 null、二进制不显示；diff 相对底子', async () => {
    const scan = await get(`/api/live/${liveId}/workspace/file?path=skills/scan/SKILL.md`);
    expect(scan).toEqual({
      path: 'skills/scan/SKILL.md',
      status: 'modified',
      content: skillMd('scan', '先列出要扫描的目录。'),
      binary: false,
    });
    expect(await get(`/api/live/${liveId}/workspace/file?path=skills/report/SKILL.md`)).toEqual({
      path: 'skills/report/SKILL.md',
      status: 'removed',
      content: null,
      binary: false,
    });
    expect(await get(`/api/live/${liveId}/workspace/file?path=skills/none/SKILL.md`)).toEqual({
      path: 'skills/none/SKILL.md',
      status: null,
      content: null,
      binary: false,
    });
    fs.writeFileSync(skill('scan/icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    expect(await get(`/api/live/${liveId}/workspace/file?path=skills/scan/icon.png`)).toEqual({
      path: 'skills/scan/icon.png',
      status: 'added',
      content: null,
      binary: true,
    });

    const diff = await get<{
      status: string;
      oldContent: string;
      newContent: string;
      patch: string;
    }>(`/api/live/${liveId}/workspace/diff?path=skills/scan/SKILL.md`);
    expect(diff.status).toBe('modified');
    expect(diff.newContent).toBe(skillMd('scan', '先列出要扫描的目录。'));
    expect(diff.oldContent).not.toBe(diff.newContent);
    expect(diff.patch).toContain('+先列出要扫描的目录。');
    const removed = await get<{ status: string; newContent: string; patch: string }>(
      `/api/live/${liveId}/workspace/diff?path=skills/report/SKILL.md`,
    );
    expect([removed.status, removed.newContent]).toEqual(['removed', '']);
    expect(removed.patch).toContain('+++ /dev/null');
  });

  test('越界的路径 400：skills/<skill>/ 以外、. 与 ..、反斜杠、绝对路径、符号链接；没有草稿的项 404', async () => {
    for (const bad of [
      'workflow.yaml',
      'PLATFORM.md',
      '../PLATFORM.md',
      'skills/../workflow.yaml',
      'skills/scan/../../../PLATFORM.md',
      'skills/./scan/SKILL.md',
      'skills/scan\\..\\..\\x',
      '/etc/passwd',
      'skills/SKILL.md',
      'skills/scan/link.md',
    ]) {
      for (const kind of ['file', 'diff']) {
        const response = await app.inject({
          method: 'GET',
          url: `/api/live/${liveId}/workspace/${kind}?path=${encodeURIComponent(bad)}`,
        });
        expect(response.statusCode, `${kind} ${bad}`).toBe(400);
        expect(response.body).toMatch(/只允许访问|符号链接/);
      }
    }
    const missing = await app.inject({ method: 'GET', url: '/api/live/nope/workspace' });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).toContain('不是设计或优化的会话');
  });

  test('workflow.yaml 解析失败时返回原文，其余照常', async () => {
    const yaml = path.join(draft.dir, 'workflow.yaml');
    // variant 草稿中它是只读副本（0444）；这里代替 mode 为 workflow 时的 agent 改它
    fs.chmodSync(yaml, 0o644);
    const original = fs.readFileSync(yaml, 'utf8');
    for (const [content, error] of [
      ['id: [unclosed\n', 'workflow.yaml 不是合法的 YAML'],
      ['name: 没有 id\n', 'workflow.yaml 不符合 workflow schema'],
      [null, '没有 workflow.yaml'],
    ] as const) {
      if (content === null) fs.rmSync(yaml);
      else fs.writeFileSync(yaml, content);
      const view = await get<Workspace>(`/api/live/${liveId}/workspace`);
      expect('error' in view.workflow && view.workflow.error).toContain(error);
      expect(view.files.length).toBeGreaterThan(0);
    }
    fs.writeFileSync(yaml, original);
    const back = await get<Workspace>(`/api/live/${liveId}/workspace`);
    expect('stages' in back.workflow).toBe(true);
  });

  test('监视：变化在 1 秒内推送；同一项的连接共用一个监视器，全部断开、关闭、删除时释放', async () => {
    const diagnostics = () => get<Diagnostics>('/api/diagnostics');
    expect((await diagnostics()).workspace).toEqual({ watchers: 0, connections: 0 });

    const a = openEvents(baseUrl, liveId);
    const b = openEvents(baseUrl, liveId);
    await Promise.all([a.ready, b.ready]);
    expect((await diagnostics()).workspace).toEqual({ watchers: 1, connections: 2 });

    let from = a.received.length;
    let written = performance.now();
    fs.appendFileSync(skill('scan/SKILL.md'), '\n再检查一遍。\n');
    const edited = await a.next('changed', from);
    expect(edited.data).toEqual({
      type: 'changed',
      paths: ['skills/scan/SKILL.md'],
      workflow: false,
    });
    expect(edited.at - written).toBeLessThan(1_000);
    await b.next('changed', 0);

    from = a.received.length;
    written = performance.now();
    fs.rmSync(skill('scan/notes.md'));
    fs.appendFileSync(path.join(draft.dir, 'workflow.yaml'), '# 注释\n');
    const both = await a.next('changed', from);
    expect(both.at - written).toBeLessThan(1_000);
    // 两处改动可能分在相邻的两次比较中
    await sleep(400);
    const events = a.received.slice(from).filter((e) => e.type === 'changed');
    expect(events.flatMap((e) => e.data.paths as string[])).toEqual(['skills/scan/notes.md']);
    expect(events.some((e) => e.data.workflow === true)).toBe(true);

    a.source.close();
    await sleep(200);
    expect((await diagnostics()).workspace).toEqual({ watchers: 1, connections: 1 });
    b.source.close();
    await sleep(200);
    expect((await diagnostics()).workspace).toEqual({ watchers: 0, connections: 0 });

    // 关闭这一项：页面收到 closed 后连接结束，监视器释放
    const item = await stopItem(liveId);
    const c = openEvents(baseUrl, liveId);
    await c.ready;
    expect((await diagnostics()).workspace).toEqual({ watchers: 1, connections: 1 });
    const hidden = await app.inject({ method: 'POST', url: `/api/live/${liveId}/hide` });
    expect(hidden.statusCode, hidden.body).toBe(200);
    expect((await c.next('closed', 0)).data).toEqual({ type: 'closed', reason: 'hidden' });
    c.source.close();
    expect((await diagnostics()).workspace).toEqual({ watchers: 0, connections: 0 });

    // 删除这一项：同样释放，之后没有草稿可读
    await app.inject({ method: 'POST', url: `/api/live/${liveId}/unhide` });
    const d = openEvents(baseUrl, liveId);
    await d.ready;
    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/live/${liveId}`,
      payload: { confirmTitle: item.title },
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect((await d.next('closed', 0)).data).toEqual({ type: 'closed', reason: 'deleted' });
    d.source.close();
    expect((await diagnostics()).workspace).toEqual({ watchers: 0, connections: 0 });
    const gone = await app.inject({ method: 'GET', url: `/api/live/${liveId}/workspace` });
    expect(gone.statusCode).toBe(404);
  });
});

// 对比的对象（Contracts 26.4、28.4）：文件改动停下 5 秒后记下快照，上一版与上次保存的 diff
describe('对比的对象：底子、上次保存、上一版', { timeout: 60_000 }, () => {
  interface Diff {
    against: string;
    status: string | null;
    oldContent: string;
    newContent: string;
  }
  interface Against {
    saved: { at: number } | null;
    previous: { at: number } | null;
  }
  const scanPath = 'skills/scan/SKILL.md';

  test('停下 5 秒后记下快照，只保留两份；上一版在记下的那一刻不变；保存后有上次保存', async () => {
    const draft = await openDraft();
    const liveId = draft.liveId ?? '';
    const scan = path.join(draft.dir, 'src', scanPath);
    const snapshotsDir = path.join(draft.dir, '.dashboard/workspace/snapshots');
    const snapshots = () =>
      fs.existsSync(snapshotsDir)
        ? fs.readdirSync(snapshotsDir).filter((name) => /^\d+$/.test(name))
        : [];
    const against = async () =>
      (await get<{ against: Against }>(`/api/live/${liveId}/workspace`)).against;
    const diff = (target: string) =>
      get<Diff>(`/api/live/${liveId}/workspace/diff?path=${scanPath}&against=${target}`);
    const refused = async (target: string) => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/live/${liveId}/workspace/diff?path=${scanPath}&against=${target}`,
      });
      expect(response.statusCode, response.body).toBe(409);
      return response.json<{ message: string }>().message;
    };
    const waitFor = async (count: number) => {
      const deadline = performance.now() + 10_000;
      while (snapshots().length < count) {
        if (performance.now() > deadline)
          throw new Error(`10 秒内没有记下第 ${String(count)} 份快照`);
        await sleep(100);
      }
    };

    // 刚准备好：没有上次保存与上一版，diff 409 原文；不传 against 为底子
    expect(await against()).toEqual({ saved: null, previous: null });
    expect(await refused('saved')).toBe(`草稿 ${draft.id} 还没有保存过`);
    expect(await refused('previous')).toBe('还没有上一版：文件改动停下 5 秒后才记下一份');
    expect((await get<Diff>(`/api/live/${liveId}/workspace/diff?path=${scanPath}`)).against).toBe(
      'base',
    );
    // 第一份：服务端第一次看到这一项之后停下 5 秒。工作目录与它相同，还没有上一版
    await sleep(3_000);
    expect(snapshots()).toEqual([]);
    await waitFor(1);
    const first = Number(snapshots()[0]);
    expect((await against()).previous).toBeNull();

    // 改动之后上一版是第一份（工作目录与最新一份不同）；2.5 秒后再改一次，停下的 5 秒从第二次算起
    const original = fs.readFileSync(scan, 'utf8');
    fs.writeFileSync(scan, skillMd('scan', '第一轮：列出目录。'));
    const changedAt = performance.now();
    expect((await against()).previous).toEqual({ at: first });
    const round1 = await diff('previous');
    expect(round1).toMatchObject({
      against: 'previous',
      status: 'modified',
      oldContent: original,
      newContent: skillMd('scan', '第一轮：列出目录。'),
    });
    await sleep(2_500);
    fs.writeFileSync(scan, skillMd('scan', '第一轮：列出要扫描的目录。'));
    await sleep(Math.max(0, changedAt + 6_000 - performance.now()));
    expect(snapshots()).toHaveLength(1);
    await waitFor(2);
    // 记下第二份之后，工作目录与它相同，上一版仍是第一份
    expect((await against()).previous).toEqual({ at: first });
    expect((await diff('previous')).oldContent).toBe(original);
    expect((await diff('base')).status).toBe('modified');

    // 保存：上次保存与工作目录相同
    const saved = await app.inject({
      method: 'POST',
      url: `/api/workflow-drafts/${draft.id}/save`,
      payload: { target: { kind: 'new', name: `对比 ${marker}`, description: '改了 scan' } },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect((await against()).saved).not.toBeNull();
    expect((await diff('saved')).status).toBe('unchanged');

    // 第二轮：上一版是第二份，上次保存的 diff 是第二轮的改动
    const second = Number(snapshots()[1]);
    fs.writeFileSync(scan, skillMd('scan', '第二轮：列出目录与文件。'));
    expect((await against()).previous).toEqual({ at: second });
    expect(await diff('previous')).toMatchObject({
      status: 'modified',
      oldContent: skillMd('scan', '第一轮：列出要扫描的目录。'),
    });
    expect(await diff('saved')).toMatchObject({
      status: 'modified',
      oldContent: skillMd('scan', '第一轮：列出要扫描的目录。'),
      newContent: skillMd('scan', '第二轮：列出目录与文件。'),
    });
    // 第三份记下后只保留最新两份
    const deadline = performance.now() + 10_000;
    while (snapshots()[0] !== String(second)) {
      if (performance.now() > deadline)
        throw new Error(`10 秒内没有记下第三份：${snapshots().join('、')}`);
      await sleep(100);
    }
    expect(snapshots()).toHaveLength(2);
    expect((await against()).previous).toEqual({ at: second });
    await stopItem(liveId);
  });
});
