import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { eq, notInArray } from 'drizzle-orm';
import { parse, stringify } from 'yaml';
import type { Db } from '../db/index.js';
import { tasks } from '../db/schema.js';
import {
  type PrTask,
  type RepoTask,
  type RubricTask,
  type Task,
  TaskDefinition,
  taskFieldIssues,
  type TaskRecord,
  type TestsTask,
  type TicketTask,
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

// 字段按 task 的评测类型的积木校验（Contracts 16.3），缺少或多出时以原文失败
export function checkTask(definition: TaskDefinition) {
  const issues = taskFieldIssues(definition);
  if (issues.length > 0) throw new Error(issues.join('；'));
}

function readTaskFile(tasksDir: string, id: string) {
  const file = taskYamlPath(tasksDir, id);
  const text = readFileSync(file, 'utf8');
  const definition = parseTaskYaml(text, file);
  if (definition.id !== id) {
    throw new Error(`${file} 的 id 为 ${definition.id}，与目录名 ${id} 不一致`);
  }
  checkTask(definition);
  return { definition, hash: createHash('sha256').update(text).digest('hex') };
}

function toRow(definition: TaskDefinition, dir: string, contentHash: string, updatedAt: Date) {
  const hidden = definition.hiddenTests;
  return {
    id: definition.id,
    kind: definition.kind,
    title: definition.title,
    persona: definition.persona,
    hiddenRequirements: definition.hiddenRequirements,
    input: definition.input ?? null,
    rubric: definition.rubric ?? null,
    ticketTitle: definition.ticket?.title ?? null,
    ticketBody: definition.ticket?.body ?? null,
    acceptanceCriteria: definition.ticket?.acceptanceCriteria ?? null,
    repoPath: definition.repo?.path ?? null,
    repoCommit: definition.repo?.commit ?? null,
    source: definition.source ?? null,
    requiredChecks: definition.requiredChecks ?? null,
    hiddenTestsDir: hidden?.dir ?? null,
    hiddenTestsConfig: hidden?.config ?? null,
    testCommand: hidden?.command ?? null,
    hiddenTestsTimeoutSeconds: hidden?.timeoutSeconds ?? null,
    hiddenTestsManifest: hidden?.manifest ?? null,
    dir,
    contentHash,
    updatedAt,
  };
}

function definitionFromRow(row: TaskRow): TaskDefinition {
  return TaskDefinition.parse({
    id: row.id,
    kind: row.kind,
    title: row.title,
    persona: row.persona,
    hiddenRequirements: row.hiddenRequirements,
    ...(row.input === null ? {} : { input: row.input }),
    ...(row.rubric === null ? {} : { rubric: row.rubric }),
    ...(row.source === null ? {} : { source: row.source }),
    ...(row.ticketTitle === null
      ? {}
      : {
          ticket: {
            title: row.ticketTitle,
            body: row.ticketBody,
            acceptanceCriteria: row.acceptanceCriteria,
          },
        }),
    ...(row.repoPath === null ? {} : { repo: { path: row.repoPath, commit: row.repoCommit } }),
    ...(row.requiredChecks === null ? {} : { requiredChecks: row.requiredChecks }),
    ...(row.hiddenTestsDir === null
      ? {}
      : {
          hiddenTests: {
            dir: row.hiddenTestsDir,
            config: row.hiddenTestsConfig,
            command: row.testCommand,
            timeoutSeconds: row.hiddenTestsTimeoutSeconds,
            manifest: row.hiddenTestsManifest,
          },
        }),
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

// 写回 tasks/<id>/task.yaml 并同步这一个 task；字段不符合评测类型时不写文件
export function saveTask(db: Db, tasksDir: string, definition: TaskDefinition): TaskRecord {
  checkTask(definition);
  const file = taskYamlPath(tasksDir, definition.id);
  mkdirSync(path.dirname(file), { recursive: true });
  // 先写临时文件再改名：写到一半时进程退出不会留下损坏的 task.yaml
  const tmp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, serializeTask(definition));
  renameSync(tmp, file);
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
  return db
    .select()
    .from(tasks)
    .orderBy(tasks.kind, tasks.id)
    .all()
    .map(toRecord);
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

// 以下按积木取出必有的字段：加载时已按评测类型校验，缺少说明调用方用错了积木
export function withRubric(task: Task): RubricTask {
  if (task.rubric === undefined) throw new Error(`task ${task.id} 没有 rubric`);
  return { ...task, rubric: task.rubric };
}

export function withTicket(task: Task): TicketTask {
  if (task.ticket === undefined) throw new Error(`task ${task.id} 没有工单`);
  return { ...task, ticket: task.ticket };
}

export function withRepo(task: Task): RepoTask {
  if (task.repo === undefined || task.requiredChecks === undefined) {
    throw new Error(`task ${task.id} 没有起始仓库与 requiredChecks`);
  }
  return { ...task, repo: task.repo, requiredChecks: task.requiredChecks };
}

export function withPr(task: Task): PrTask {
  const { repo, requiredChecks } = withRepo(task);
  return { ...task, repo, requiredChecks, ticket: withTicket(task).ticket };
}

// 隐藏测试的执行与清单生成只用于带隐藏测试的 task
export function withHiddenTests(task: Task): TestsTask {
  if (task.hiddenTests === undefined) throw new Error(`task ${task.id} 没有隐藏测试`);
  return { ...withRepo(task), hiddenTests: task.hiddenTests };
}
