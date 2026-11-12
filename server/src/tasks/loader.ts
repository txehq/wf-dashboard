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

// Canonical form of task.yaml: saving from the page, reading back and saving again leaves the file unchanged
export function serializeTask(definition: TaskDefinition): string {
  return stringify(TaskDefinition.parse(definition), { lineWidth: 0 });
}

export function parseTaskYaml(text: string, file: string): TaskDefinition {
  const result = TaskDefinition.safeParse(parse(text));
  if (!result.success) throw new Error(`${file} does not match the task schema: ${result.error.message}`);
  return result.data;
}

// Fields are checked against the blocks of the task's eval kind (Contracts 16.3); missing or extra ones fail with the exact text
export function checkTask(definition: TaskDefinition) {
  const issues = taskFieldIssues(definition);
  if (issues.length > 0) throw new Error(issues.join('; '));
}

function readTaskFile(tasksDir: string, id: string) {
  const file = taskYamlPath(tasksDir, id);
  const text = readFileSync(file, 'utf8');
  const definition = parseTaskYaml(text, file);
  if (definition.id !== id) {
    throw new Error(`${file} has id ${definition.id}, which does not match the directory name ${id}`);
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

// The task ids in a tasks directory, sorted: a directory holding a task.yaml is a task, anything else (a stray file such as .DS_Store, a
// directory without task.yaml) is not
export function listTaskIds(tasksDir: string): string[] {
  return readdirSync(tasksDir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(taskYamlPath(tasksDir, e.name)))
    .map((e) => e.name)
    .sort();
}

// Syncs tasks/*/task.yaml into the tasks table; tasks whose files were deleted are removed (a foreign key error if a run references them)
export function syncTasks(db: Db, tasksDir: string): SyncResult {
  const ids = listTaskIds(tasksDir);
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

// Writes tasks/<id>/task.yaml and syncs this one task; nothing is written when the fields do not fit the eval kind
export function saveTask(db: Db, tasksDir: string, definition: TaskDefinition): TaskRecord {
  checkTask(definition);
  const file = taskYamlPath(tasksDir, definition.id);
  mkdirSync(path.dirname(file), { recursive: true });
  // Write a temp file and rename it: a process exit halfway through leaves no corrupt task.yaml
  const tmp = `${file}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, serializeTask(definition));
  renameSync(tmp, file);
  db.transaction((tx) => {
    upsert(tx, tasksDir, definition.id, emptyResult());
  });
  const record = getTaskRecord(db, definition.id);
  if (!record) throw new Error(`Task ${definition.id} cannot be read after writing`);
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

// For runs and grading: the task with the absolute path of its directory
export function loadTask(db: Db, id: string): Task {
  const record = getTaskRecord(db, id);
  if (!record) throw new Error(`Task not found: ${id}`);
  return { ...record.task, dir: record.dir };
}

// The following take out the fields a block requires: loading already checked them against the eval kind, so a missing one means the caller used the wrong block
export function withRubric(task: Task): RubricTask {
  if (task.rubric === undefined) throw new Error(`Task ${task.id} has no rubric`);
  return { ...task, rubric: task.rubric };
}

export function withTicket(task: Task): TicketTask {
  if (task.ticket === undefined) throw new Error(`Task ${task.id} has no ticket`);
  return { ...task, ticket: task.ticket };
}

export function withRepo(task: Task): RepoTask {
  if (task.repo === undefined || task.requiredChecks === undefined) {
    throw new Error(`Task ${task.id} has no starting repo and requiredChecks`);
  }
  return { ...task, repo: task.repo, requiredChecks: task.requiredChecks };
}

export function withPr(task: Task): PrTask {
  const { repo, requiredChecks } = withRepo(task);
  return { ...task, repo, requiredChecks, ticket: withTicket(task).ticket };
}

// Running hidden tests and generating the manifest only apply to tasks with hidden tests
export function withHiddenTests(task: Task): TestsTask {
  if (task.hiddenTests === undefined) throw new Error(`Task ${task.id} has no hidden tests`);
  return { ...withRepo(task), hiddenTests: task.hiddenTests };
}
