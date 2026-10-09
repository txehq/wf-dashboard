import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { eq, notInArray } from 'drizzle-orm';
import { parse, stringify } from 'yaml';
import type { Db } from '../db/index.js';
import { tasks } from '../db/schema.js';
import {
  type IcTask,
  type LfgTask,
  type Task,
  TaskDefinition,
  type TaskRecord,
} from './schema.js';

type TaskRow = typeof tasks.$inferSelect;
type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export const taskYamlPath = (tasksDir: string, id: string) =>
  path.join(tasksDir, id, 'task.yaml');

// task.yaml 的规范写法：页面保存后再读回、再保存，文件内容不变
export function serializeTask(definition: TaskDefinition): string {
  return stringify(TaskDefinition.parse(definition), { lineWidth: 0 });
}

export function parseTaskYaml(text: string, file: string): TaskDefinition {
  const result = TaskDefinition.safeParse(parse(text));
  if (!result.success) throw new Error(`${file} 不符合 task schema：${result.error.message}`);
  return result.data;
}

function readTaskFile(tasksDir: string, id: string) {
  const file = taskYamlPath(tasksDir, id);
  const text = readFileSync(file, 'utf8');
  const definition = parseTaskYaml(text, file);
  if (definition.id !== id) {
    throw new Error(`${file} 的 id 为 ${definition.id}，与目录名 ${id} 不一致`);
  }
  return { definition, hash: createHash('sha256').update(text).digest('hex') };
}

function toRow(definition: TaskDefinition, dir: string, contentHash: string, updatedAt: Date) {
  const base = {
    id: definition.id,
    kind: definition.kind,
    title: definition.title,
    persona: definition.persona,
    hiddenRequirements: definition.hiddenRequirements,
    dir,
    contentHash,
    updatedAt,
  };
  if (definition.kind === 'lfg') {
    return {
      ...base,
      input: definition.input,
      rubric: definition.rubric,
      ticketTitle: null,
      ticketBody: null,
      acceptanceCriteria: null,
      repoPath: null,
      repoCommit: null,
      hiddenTestsDir: null,
      testCommand: null,
      hiddenTestsManifest: null,
    };
  }
  return {
    ...base,
    input: null,
    rubric: null,
    ticketTitle: definition.ticket.title,
    ticketBody: definition.ticket.body,
    acceptanceCriteria: definition.ticket.acceptanceCriteria,
    repoPath: definition.repo.path,
    repoCommit: definition.repo.commit,
    hiddenTestsDir: definition.hiddenTests.dir,
    testCommand: definition.hiddenTests.command,
    hiddenTestsManifest: definition.hiddenTests.manifest,
  };
}

function definitionFromRow(row: TaskRow): TaskDefinition {
  const base = {
    id: row.id,
    title: row.title,
    persona: row.persona,
    hiddenRequirements: row.hiddenRequirements,
  };
  if (row.kind === 'lfg') {
    return TaskDefinition.parse({ ...base, kind: 'lfg', input: row.input, rubric: row.rubric });
  }
  return TaskDefinition.parse({
    ...base,
    kind: 'ic',
    ticket: {
      title: row.ticketTitle,
      body: row.ticketBody,
      acceptanceCriteria: row.acceptanceCriteria,
    },
    repo: { path: row.repoPath, commit: row.repoCommit },
    hiddenTests: {
      dir: row.hiddenTestsDir,
      command: row.testCommand,
      manifest: row.hiddenTestsManifest,
    },
  });
}

export interface SyncResult {
  inserted: string[];
  updated: string[];
  unchanged: string[];
  deleted: string[];
}

const emptyResult = (): SyncResult => ({ inserted: [], updated: [], unchanged: [], deleted: [] });

function upsert(tx: Tx, tasksDir: string, id: string, result: SyncResult) {
  const { definition, hash } = readTaskFile(tasksDir, id);
  const existing = tx
    .select({ contentHash: tasks.contentHash })
    .from(tasks)
    .where(eq(tasks.id, id))
    .get();
  if (existing?.contentHash === hash) {
    result.unchanged.push(id);
    return;
  }
  const row = toRow(definition, path.join(tasksDir, id), hash, new Date());
  if (existing) {
    tx.update(tasks).set(row).where(eq(tasks.id, id)).run();
    result.updated.push(id);
  } else {
    tx.insert(tasks).values(row).run();
    result.inserted.push(id);
  }
}

// 把 tasks/*/task.yaml 同步进 tasks 表；文件已删除的 task 从表中删除（被 run 引用时外键报错）
export function syncTasks(db: Db, tasksDir: string): SyncResult {
  const ids = readdirSync(tasksDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(taskYamlPath(tasksDir, e.name)))
    .map((e) => e.name)
    .sort();
  const result = emptyResult();
  db.transaction((tx) => {
    for (const id of ids) upsert(tx, tasksDir, id, result);
    const stale = tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(notInArray(tasks.id, ids))
      .all()
      .map((r) => r.id);
    if (stale.length > 0) {
      tx.delete(tasks).where(notInArray(tasks.id, ids)).run();
      result.deleted.push(...stale);
    }
  });
  return result;
}

// 写回 tasks/<id>/task.yaml 并同步这一个 task
export function saveTask(db: Db, tasksDir: string, definition: TaskDefinition): TaskRecord {
  const file = taskYamlPath(tasksDir, definition.id);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, serializeTask(definition));
  db.transaction((tx) => {
    upsert(tx, tasksDir, definition.id, emptyResult());
  });
  const record = getTaskRecord(db, definition.id);
  if (!record) throw new Error(`task ${definition.id} 写入后读不到`);
  return record;
}

const toRecord = (row: TaskRow): TaskRecord => ({
  task: definitionFromRow(row),
  dir: row.dir,
  updatedAt: row.updatedAt.getTime(),
});

export function listTaskRecords(db: Db): TaskRecord[] {
  return db.select().from(tasks).orderBy(tasks.kind, tasks.id).all().map(toRecord);
}

export function getTaskRecord(db: Db, id: string): TaskRecord | undefined {
  const row = db.select().from(tasks).where(eq(tasks.id, id)).get();
  return row && toRecord(row);
}

// 供 runs、grading 使用：带 task 目录绝对路径的 task
export function loadTask(db: Db, id: string): Task {
  const record = getTaskRecord(db, id);
  if (!record) throw new Error(`没有 task ${id}`);
  return { ...record.task, dir: record.dir };
}

export function loadLfgTask(db: Db, id: string): LfgTask {
  const task = loadTask(db, id);
  if (task.kind !== 'lfg') throw new Error(`task ${id} 不是 lfg task`);
  return task;
}

export function loadIcTask(db: Db, id: string): IcTask {
  const task = loadTask(db, id);
  if (task.kind !== 'ic') throw new Error(`task ${id} 不是 ic task`);
  return task;
}
