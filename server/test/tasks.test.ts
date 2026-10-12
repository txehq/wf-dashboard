import { randomUUID } from 'node:crypto';
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { tasks } from '../src/db/schema.js';
import {
  loadTask,
  parseTaskYaml,
  saveTask,
  serializeTask,
  syncTasks,
  taskYamlPath,
  withRepo,
  withRubric,
} from '../src/tasks/loader.js';
import { rubricMaxScore } from '../src/tasks/schema.js';
import { builtinDefinition } from '../src/workflows/index.js';
import { bigStageOf, rubricOf } from '../src/workflows/schema.js';

// dev-workflow 的 lfg 评分的产物：rubric 分组依次与它们一致
const lfgArtifacts = (rubricOf(bigStageOf(builtinDefinition(), 'lfg')) ?? []).map((a) => a.id);

const workDir = path.join(config.repoRoot, '.work', 'test-tasks', randomUUID());
const cleanups: (() => void)[] = [];

afterAll(() => {
  for (const cleanup of cleanups) cleanup();
  rmSync(workDir, { recursive: true, force: true });
});

function openTestDb() {
  const file = path.join(workDir, `${randomUUID()}.sqlite`);
  const db = openDatabase(file, config.migrationsDir);
  cleanups.push(() => {
    db.$client.close();
  });
  return db;
}

// 复制 tasks/ 中的 task.yaml，修改与删除不影响仓库中的文件
function copyTasksDir() {
  const dir = path.join(workDir, `tasks-${randomUUID()}`);
  cpSync(config.tasksDir, dir, {
    recursive: true,
    filter: (source) => !source.endsWith('.bundle'),
  });
  return dir;
}

const builtinIds = readdirSync(config.tasksDir).sort();

describe('自带 task', () => {
  test('一共 7 个：lfg 3 个，ic 4 个', () => {
    expect(builtinIds).toEqual([
      'ic-money-format',
      'ic-task-store-list',
      'ic-unit-converter',
      'ic-wrap-cli',
      'lfg-calculator',
      'lfg-photo-sorter',
      'lfg-todo-api',
    ]);
  });

  test.each(builtinIds)('%s 的 task.yaml 通过 schema', (id) => {
    const file = taskYamlPath(config.tasksDir, id);
    const definition = parseTaskYaml(readFileSync(file, 'utf8'), file);
    expect(definition.id).toBe(id);
    expect(definition.workflow).toBe('dev-workflow');
    expect(definition.bigStage).toBe(id.split('-')[0]);
    if (definition.bigStage === 'lfg') {
      const rubric = definition.rubric;
      if (rubric === undefined) throw new Error(`${id} 没有 rubric`);
      expect(lfgArtifacts).toEqual(['brief', 'research', 'plan', 'tickets']);
      expect(rubric.map((g) => g.artifact)).toEqual(lfgArtifacts);
      for (const group of rubric) {
        expect(group.items.length).toBeGreaterThanOrEqual(4);
        expect(group.items.length).toBeLessThanOrEqual(8);
      }
      expect(rubricMaxScore(rubric)).toBeGreaterThan(0);
    } else {
      // 自带 ic task 都有隐藏测试，CI 的 check 名都是 ci
      expect(definition.requiredChecks).toEqual(['ci']);
      const hidden = definition.hiddenTests;
      if (hidden === undefined) throw new Error(`${id} 没有隐藏测试`);
      const declared = Object.values(hidden.manifest).flat();
      expect(declared.length).toBeGreaterThanOrEqual(10);
      for (const file of Object.keys(hidden.manifest)) {
        expect(file.startsWith('test/hidden/')).toBe(true);
      }
    }
  });

  test.each(builtinIds)('%s 的 task.yaml 写出再读回内容相同', (id) => {
    const file = taskYamlPath(config.tasksDir, id);
    const definition = parseTaskYaml(readFileSync(file, 'utf8'), file);
    expect(parseTaskYaml(serializeTask(definition), file)).toEqual(definition);
  });
});

describe('loader', () => {
  test('同步是幂等的：第二次全部 unchanged，行内容不变', () => {
    const db = openTestDb();
    const first = syncTasks(db, config.tasksDir);
    expect(first.inserted).toEqual(builtinIds);
    const rowsAfterFirst = db.select().from(tasks).orderBy(tasks.id).all();

    const second = syncTasks(db, config.tasksDir);
    expect(second).toEqual({ inserted: [], updated: [], unchanged: builtinIds, deleted: [] });
    expect(db.select().from(tasks).orderBy(tasks.id).all()).toEqual(rowsAfterFirst);
  });

  test('加载出的 task 带 task 目录的绝对路径', () => {
    const db = openTestDb();
    syncTasks(db, config.tasksDir);
    const ic = withRepo(loadTask(db, 'ic-money-format'));
    expect(ic.dir).toBe(path.join(config.tasksDir, 'ic-money-format'));
    expect(ic.repo.path).toBe('repo.bundle');
    expect(withRubric(loadTask(db, 'lfg-calculator')).input).toBe('做一个计算器');
    expect(() => withRubric(loadTask(db, 'ic-money-format'))).toThrow(/没有 rubric/);
  });

  test('文件修改后更新对应行，删除目录后删除对应行', () => {
    const db = openTestDb();
    const dir = copyTasksDir();
    syncTasks(db, dir);

    const file = taskYamlPath(dir, 'lfg-todo-api');
    const definition = parseTaskYaml(readFileSync(file, 'utf8'), file);
    saveTask(db, dir, { ...definition, title: '改过的标题' });
    expect(readFileSync(file, 'utf8')).toContain('title: 改过的标题');
    expect(db.select().from(tasks).where(eq(tasks.id, 'lfg-todo-api')).get()?.title).toBe(
      '改过的标题',
    );

    rmSync(path.join(dir, 'lfg-photo-sorter'), { recursive: true });
    const result = syncTasks(db, dir);
    expect(result.deleted).toEqual(['lfg-photo-sorter']);
    expect(result.updated).toEqual([]);
    expect(result.unchanged).toHaveLength(builtinIds.length - 1);
  });

  test('不符合 schema 的 task.yaml 让同步失败并指出文件', () => {
    const db = openTestDb();
    const dir = copyTasksDir();
    const file = taskYamlPath(dir, 'lfg-calculator');
    writeFileSync(file, readFileSync(file, 'utf8').replace('bigStage: lfg', 'bigStage: LFG'));
    expect(() => syncTasks(db, dir)).toThrow(`${file} 不符合 task schema`);
  });

  test('字段按大阶段的积木校验：缺少或多出字段时同步以原文失败', () => {
    const db = openTestDb();
    const dir = copyTasksDir();
    const file = taskYamlPath(dir, 'lfg-calculator');
    const definition = parseTaskYaml(readFileSync(file, 'utf8'), file);
    writeFileSync(file, serializeTask({ ...definition, bigStage: 'ic' }));
    expect(() => syncTasks(db, dir)).toThrow(
      'task lfg-calculator（dev-workflow 的大阶段 ic）缺少字段：ticket、repo、requiredChecks；task lfg-calculator（dev-workflow 的大阶段 ic）多出字段：input、rubric',
    );
    writeFileSync(file, serializeTask({ ...definition, bigStage: 'nope' }));
    expect(() => syncTasks(db, dir)).toThrow('workflow dev-workflow 没有大阶段 nope');
  });

  test('task.yaml 的 id 必须与目录名一致', () => {
    const db = openTestDb();
    const dir = copyTasksDir();
    cpSync(taskYamlPath(dir, 'lfg-todo-api'), taskYamlPath(dir, 'lfg-calculator'));
    expect(() => syncTasks(db, dir)).toThrow(
      /的 id 为 lfg-todo-api，与目录名 lfg-calculator 不一致/,
    );
  });
});
