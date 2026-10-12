import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, test } from 'vitest';
import { parse, stringify } from 'yaml';
import { config } from '../../src/config.js';
import { listTaskRecords, syncTasks } from '../../src/tasks/loader.js';
import { openTestDb } from '../stages/db.js';

// Contracts 16.3：task 属于一种评测类型（kind: lfg | ic），字段按评测类型的积木校验
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

describe('task 的评测类型', () => {
  test('自带的 7 个 task 全部加载，kind 为 lfg 或 ic', () => {
    const result = syncTasks(db, config.tasksDir);
    expect(result.deleted).toEqual([]);
    expect(listTaskRecords(db).map((r) => [r.task.id, r.task.kind])).toEqual([
      ['ic-money-format', 'ic'],
      ['ic-task-store-list', 'ic'],
      ['ic-unit-converter', 'ic'],
      ['ic-wrap-cli', 'ic'],
      ['lfg-calculator', 'lfg'],
      ['lfg-photo-sorter', 'lfg'],
      ['lfg-todo-api', 'lfg'],
    ]);
  });

  test('缺少评测类型要求的字段以原文失败', () => {
    const dir = tasksDirWith('ic-money-format', (t) => {
      delete t.requiredChecks;
      delete t.repo;
    });
    expect(() => syncTasks(db, dir)).toThrow(
      'task ic-money-format（ic）缺少字段：repo、requiredChecks',
    );
  });

  test('多出评测类型没有的字段以原文失败', () => {
    const dir = tasksDirWith('lfg-calculator', (t) => {
      t.requiredChecks = ['ci'];
    });
    expect(() => syncTasks(db, dir)).toThrow('task lfg-calculator（lfg）多出字段：requiredChecks');
  });

  test('rubric 分组与评测类型的产物不一致、kind 不是 lfg 或 ic 时以原文失败', () => {
    const groups = tasksDirWith('lfg-calculator', (t) => {
      t.rubric = (t.rubric as unknown[]).slice(0, 3);
    });
    expect(() => syncTasks(db, groups)).toThrow(
      'task lfg-calculator（lfg）的 rubric 必须依次包含 brief、research、plan、tickets 各组，实际为 brief,research,plan',
    );
    const kind = tasksDirWith('lfg-calculator', (t) => {
      t.kind = 'review';
    });
    expect(() => syncTasks(db, kind)).toThrow(/不符合 task schema/);
  });

  test('W36 的写法 workflow 与 bigStage 不再被接受', () => {
    const dir = tasksDirWith('lfg-calculator', (t) => {
      delete t.kind;
      t.workflow = 'dev-workflow';
      t.bigStage = 'lfg';
    });
    expect(() => syncTasks(db, dir)).toThrow(/不符合 task schema/);
  });
});
