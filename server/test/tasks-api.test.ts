import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { parseTaskYaml, syncTasks, taskYamlPath } from '../src/tasks/loader.js';
import {
  type ArtifactRubric,
  RubricDraft,
  type RubricDraftRequest,
  type TaskDefinition,
  type TaskRecord,
} from '../src/tasks/schema.js';
import { EVAL_KINDS } from '../src/workflows/eval-kinds.js';
import { rubricOf } from '../src/workflows/schema.js';

// 有 rubric 的 task 定义（lfg 评测类型）
type RubricTaskDefinition = TaskDefinition & { rubric: ArtifactRubric[] };
const lfgArtifacts = (rubricOf(EVAL_KINDS.lfg) ?? []).map((a) => a.id);

const workDir = path.join(config.repoRoot, '.work', 'test-tasks-api', randomUUID());
// 写操作落在 tasks/ 的副本上
const tasksDir = path.join(workDir, 'tasks');
cpSync(config.tasksDir, tasksDir, { recursive: true });
const db = openDatabase(path.join(workDir, 'db.sqlite'), config.migrationsDir);
syncTasks(db, tasksDir);
const app = await buildApp({ db, sseHeartbeatMs: config.sseHeartbeatMs, logger: false, tasksDir });

beforeAll(async () => {
  await app.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  await app.close();
  db.$client.close();
  rmSync(workDir, { recursive: true, force: true });
});

function url(pathname: string) {
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('server 未监听 TCP 端口');
  return `http://127.0.0.1:${String(address.port)}${pathname}`;
}

async function call(method: string, pathname: string, body?: unknown) {
  const response = await fetch(url(pathname), {
    method,
    ...(body === undefined
      ? {}
      : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const json: unknown = await response.json();
  return { status: response.status, body: json };
}

async function getLfg(id: string): Promise<RubricTaskDefinition> {
  const { body } = await call('GET', `/api/tasks/${id}`);
  const { task } = body as TaskRecord;
  if (task.kind !== 'lfg' || task.rubric === undefined) throw new Error(`${id} 不是 lfg task`);
  return { ...task, rubric: task.rubric };
}

describe('Tasks API', () => {
  test('GET /api/tasks 列出 7 个自带 task', async () => {
    const { status, body } = await call('GET', '/api/tasks');
    expect(status).toBe(200);
    const records = body as TaskRecord[];
    expect(records.map((r) => `${r.task.kind}:${r.task.id}`)).toEqual([
      'ic:ic-money-format',
      'ic:ic-task-store-list',
      'ic:ic-unit-converter',
      'ic:ic-wrap-cli',
      'lfg:lfg-calculator',
      'lfg:lfg-photo-sorter',
      'lfg:lfg-todo-api',
    ]);
    expect(records[0]?.dir).toBe(path.join(tasksDir, 'ic-money-format'));
  });

  test('GET 不存在的 task 返回 404', async () => {
    const { status, body } = await call('GET', '/api/tasks/nope');
    expect(status).toBe(404);
    expect(body).toMatchObject({ message: '没有 task nope' });
  });

  test('PUT 保存后写回 task.yaml，再次读取得到新内容', async () => {
    const task = await getLfg('lfg-todo-api');
    const [brief, ...rest] = task.rubric;
    if (!brief) throw new Error('缺少 brief 组');
    const edited: RubricTaskDefinition = {
      ...task,
      persona: `${task.persona}\n补充：周末不看消息。`,
      rubric: [
        { ...brief, items: [...brief.items, { id: 'b9', criterion: '新增条目', maxScore: 2 }] },
        ...rest,
      ],
    };
    const { status, body } = await call('PUT', '/api/tasks/lfg-todo-api', edited);
    expect(status).toBe(200);
    expect((body as TaskRecord).task).toEqual(edited);

    const file = taskYamlPath(tasksDir, 'lfg-todo-api');
    expect(parseTaskYaml(readFileSync(file, 'utf8'), file)).toEqual(edited);
    expect(await getLfg('lfg-todo-api')).toEqual(edited);
  });

  test('PUT 校验 body：rubric 不合法返回 400，id、workflow 或大阶段不一致返回 400', async () => {
    const task = await getLfg('lfg-calculator');
    const noTickets = { ...task, rubric: task.rubric.slice(0, 3) };
    const missing = await call('PUT', '/api/tasks/lfg-calculator', noTickets);
    expect(missing.status).toBe(400);
    expect(JSON.stringify(missing.body)).toContain(
      '的 rubric 必须依次包含 brief、research、plan、tickets 各组',
    );
    expect((await call('PUT', '/api/tasks/lfg-todo-api', task)).status).toBe(400);
    const moved = await call('PUT', '/api/tasks/lfg-calculator', { ...task, bigStage: 'ic' });
    expect(moved.status).toBe(400);
    expect(moved.body).toMatchObject({
      message: 'task lfg-calculator 的 workflow 与大阶段不能改变',
    });
  });

  test('POST 新建 task，写出 task.yaml；重复 id 返回 409', async () => {
    const task = await getLfg('lfg-calculator');
    const created: RubricTaskDefinition = {
      ...task,
      id: 'lfg-unit-converter',
      title: '单位换算',
      input: '做一个单位换算工具',
    };
    const first = await call('POST', '/api/tasks', created);
    expect(first.status).toBe(201);
    expect((first.body as TaskRecord).task).toEqual(created);
    const file = taskYamlPath(tasksDir, 'lfg-unit-converter');
    expect(parseTaskYaml(readFileSync(file, 'utf8'), file)).toEqual(created);

    expect((await call('POST', '/api/tasks', created)).status).toBe(409);
    const list = (await call('GET', '/api/tasks')).body as TaskRecord[];
    expect(list).toHaveLength(8);
  });

  test('起草请求的评测类型必须有 rubric 评分', async () => {
    const { body } = await call('GET', '/api/tasks/ic-wrap-cli');
    expect((await call('POST', '/api/tasks/rubric-draft', (body as TaskRecord).task)).status).toBe(
      400,
    );
  });

  test('POST rubric-draft 按表单内容（不含 rubric）真实调用 judge 模型，返回合法草稿且不保存', async () => {
    const before = readFileSync(taskYamlPath(tasksDir, 'lfg-calculator'), 'utf8');
    const task = await getLfg('lfg-calculator');
    const form: RubricDraftRequest = {
      id: task.id,
      kind: task.kind,
      title: task.title,
      persona: task.persona,
      hiddenRequirements: task.hiddenRequirements,
      ...(task.input === undefined ? {} : { input: task.input }),
    };
    const { status, body } = await call('POST', '/api/tasks/rubric-draft', form);
    expect(status).toBe(200);
    const draft = RubricDraft.parse(body);
    expect(draft.rubric.map((g) => g.artifact)).toEqual(lfgArtifacts);
    for (const group of draft.rubric) {
      expect(group.items.length).toBeGreaterThanOrEqual(4);
      expect(group.items.length).toBeLessThanOrEqual(8);
      for (const item of group.items) {
        expect(item.maxScore).toBeGreaterThanOrEqual(1);
        expect(item.maxScore).toBeLessThanOrEqual(5);
      }
    }
    expect(draft.costUsd).toBeGreaterThan(0);
    expect(readFileSync(taskYamlPath(tasksDir, 'lfg-calculator'), 'utf8')).toBe(before);

    // 留给报告摘录
    const out = path.join(config.repoRoot, '.work', 'rubric-draft');
    mkdirSync(out, { recursive: true });
    writeFileSync(path.join(out, 'lfg-calculator.json'), JSON.stringify(draft, null, 2));
  }, 300_000);
});
