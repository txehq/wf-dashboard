import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, test } from 'vitest';
import { parse, stringify } from 'yaml';
import { config } from '../../src/config.js';
import { listTaskRecords, syncTasks } from '../../src/tasks/loader.js';
import { openTestDb } from '../stages/db.js';

// Contracts 16.3：task 绑定一个 workflow 的一个大阶段，字段按大阶段的积木校验
const { db, close } = openTestDb();
const work = path.join(config.repoRoot, '.work', 'test-task-fields', randomUUID());
afterAll(() => {
  close();
  fs.rmSync(work, { recursive: true, force: true });
});

// 把一个自带 task 的 task.yaml 改写后放进独立的 tasks 目录
function tasksDirWith(id: string, change: (task: Record<string, unknown>) => void): string {
  const dir = path.join(work, randomUUID());
  fs.mkdirSync(path.join(dir, id), { recursive: true });
  const task = parse(
    fs.readFileSync(path.join(config.tasksDir, id, 'task.yaml'), 'utf8'),
  ) as Record<string, unknown>;
  change(task);
  fs.writeFileSync(path.join(dir, id, 'task.yaml'), stringify(task));
  return dir;
}

describe('task 的 workflow 与大阶段', () => {
  test('自带的 7 个 task 全部加载为 dev-workflow 的 lfg 或 ic', () => {
    const result = syncTasks(db, config.tasksDir);
    expect(result.deleted).toEqual([]);
    expect(
      listTaskRecords(db).map((r) => [r.task.id, r.task.workflow, r.task.bigStage]),
    ).toEqual([
      ['ic-money-format', 'dev-workflow', 'ic'],
      ['ic-task-store-list', 'dev-workflow', 'ic'],
      ['ic-unit-converter', 'dev-workflow', 'ic'],
      ['ic-wrap-cli', 'dev-workflow', 'ic'],
      ['lfg-calculator', 'dev-workflow', 'lfg'],
      ['lfg-photo-sorter', 'dev-workflow', 'lfg'],
      ['lfg-todo-api', 'dev-workflow', 'lfg'],
    ]);
  });

  test('缺少大阶段要求的字段以原文失败', () => {
    const dir = tasksDirWith('ic-money-format', (t) => {
      delete t.requiredChecks;
      delete t.repo;
    });
    expect(() => syncTasks(db, dir)).toThrow(
      'task ic-money-format（dev-workflow 的大阶段 ic）缺少字段：repo、requiredChecks',
    );
  });

  test('多出大阶段没有的字段以原文失败', () => {
    const dir = tasksDirWith('lfg-calculator', (t) => {
      t.requiredChecks = ['ci'];
    });
    expect(() => syncTasks(db, dir)).toThrow(
      'task lfg-calculator（dev-workflow 的大阶段 lfg）多出字段：requiredChecks',
    );
  });

  test('rubric 分组与大阶段的产物不一致、大阶段不存在时以原文失败', () => {
    const groups = tasksDirWith('lfg-calculator', (t) => {
      t.rubric = (t.rubric as unknown[]).slice(0, 3);
    });
    expect(() => syncTasks(db, groups)).toThrow(
      'task lfg-calculator（dev-workflow 的大阶段 lfg）的 rubric 必须依次包含 brief、research、plan、tickets 各组，实际为 brief,research,plan',
    );
    const stage = tasksDirWith('lfg-calculator', (t) => {
      t.bigStage = 'newlfg';
    });
    expect(() => syncTasks(db, stage)).toThrow('workflow dev-workflow 没有大阶段 newlfg');
  });

  test('旧写法 kind 不再被接受', () => {
    const dir = tasksDirWith('lfg-calculator', (t) => {
      delete t.workflow;
      delete t.bigStage;
      t.kind = 'lfg';
    });
    expect(() => syncTasks(db, dir)).toThrow(/不符合 task schema/);
  });
});
