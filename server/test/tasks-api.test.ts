import { randomUUID } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { parseTaskYaml, syncTasks, taskYamlPath } from '../src/tasks/loader.js';
import {
  type LfgTaskDefinition,
  RubricDraft,
  type RubricDraftRequest,
  rubricArtifacts,
  type TaskRecord,
} from '../src/tasks/schema.js';

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

async function getLfg(id: string): Promise<LfgTaskDefinition> {
  const { body } = await call('GET', `/api/tasks/${id}`);
  const { task } = body as TaskRecord;
  if (task.kind !== 'lfg') throw new Error(`${id} 不是 lfg task`);
  return task;
}

describe('Tasks API', () => {
  test('GET /api/tasks 列出 6 个自带 task', async () => {
    const { status, body } = await call('GET', '/api/tasks');
    expect(status).toBe(200);
    const records = body as TaskRecord[];
    expect(records.map((r) => `${r.task.kind}:${r.task.id}`)).toEqual([
      'ic:ic-money-format',
      'ic:ic-task-store-list',
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
    const edited: LfgTaskDefinition = {
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

  test('PUT 校验 body：rubric 不合法返回 400，id 或 kind 不一致返回 400', async () => {
    const task = await getLfg('lfg-calculator');
    const noTickets = { ...task, rubric: task.rubric.slice(0, 3) };
    expect((await call('PUT', '/api/tasks/lfg-calculator', noTickets)).status).toBe(400);
    expect((await call('PUT', '/api/tasks/lfg-todo-api', task)).status).toBe(400);
  });

  test('POST 新建 task，写出 task.yaml；重复 id 返回 409', async () => {
    const task = await getLfg('lfg-calculator');
    const created: LfgTaskDefinition = {
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
    expect(list).toHaveLength(7);
  });

  test('起草请求的 body 必须是 lfg task 定义', async () => {
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
      input: task.input,
    };
    const { status, body } = await call('POST', '/api/tasks/rubric-draft', form);
    expect(status).toBe(200);
    const draft = RubricDraft.parse(body);
    expect(draft.rubric.map((g) => g.artifact)).toEqual([...rubricArtifacts]);
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
