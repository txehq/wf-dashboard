import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { artifacts, batches, runs, variants } from '../../src/db/schema.js';
import { RubricArtifacts } from '../../src/runs/rubric-artifacts.js';
import { featureDir } from '../../src/stages/artifacts.js';
import { syncTasks } from '../../src/tasks/loader.js';
import { EVAL_KINDS } from '../../src/workflows/eval-kinds.js';
import { rubricOf } from '../../src/workflows/schema.js';
import { openTestDb } from '../stages/db.js';

// lfg run r-20261009-dqva52 写出的真实 Brief.md、Research.md、Tickets.md（vault 中 Project Magi Eval 的 feature 目录）
const runId = 'r-20261009-dqva52';
const source = path.join(config.vaultDir, 'Project Magi Eval', 'Features', runId);
const work = path.join(config.repoRoot, '.work', 'test-rubric-artifacts', randomUUID());

const { db, close } = openTestDb();
syncTasks(db, config.tasksDir);
const variantId = randomUUID();
db.insert(variants)
  .values({
    id: variantId,
    name: `rubric-artifacts-${variantId.slice(0, 8)}`,
    workflowId: 'lfg',
    baseCommit: '0'.repeat(40),
    skillsHash: 'a'.repeat(64),
    version: '0.0.0-eval.aaaaaaaa',
  })
  .run();
db.insert(batches).values({ id: 'b-20261009-lfgart', repeats: 1 }).run();
db.insert(runs)
  .values({
    id: runId,
    batchId: 'b-20261009-lfgart',
    taskId: 'lfg-calculator',
    variantId,
    repeatIndex: 0,
    model: 'opus',
    effort: 'high',
    status: 'running',
    sessionId: randomUUID(),
    workspacePath: path.join(work, 'workspace'),
  })
  .run();

afterAll(() => {
  close();
  fs.rmSync(work, { recursive: true, force: true });
});

const snapshot = (kind: 'brief' | 'research' | 'plan' | 'tickets') =>
  db
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.runId, runId), eq(artifacts.kind, kind)))
    .get()?.snapshot;

describe('lfg run 的 rubric 产物记录', () => {
  test('产物出现时写入快照；plan 锁定后 research 保留锁定前的内容', () => {
    const dir = featureDir(path.join(work, 'vault'), 'Magi Eval', runId);
    const specs = rubricOf(EVAL_KINDS.lfg);
    if (specs === null) throw new Error('lfg 评测类型没有 rubric 评分');
    const recorder = new RubricArtifacts(db, runId, dir, specs);
    // feature 目录在 interview 写出 Brief.md 时才出现
    recorder.record();
    expect(snapshot('brief')).toBeUndefined();
    fs.mkdirSync(dir, { recursive: true });
    const read = (file: string) => fs.readFileSync(path.join(source, file), 'utf8');
    fs.writeFileSync(path.join(dir, 'Brief.md'), read('Brief.md'));
    recorder.record();
    expect(snapshot('brief')).toBe(read('Brief.md'));

    // 真实 Research.md 已锁定：首次出现时只算 research
    const research = read('Research.md');
    fs.writeFileSync(path.join(dir, 'Research.md'), research);
    recorder.record();
    expect(snapshot('research')).toBe(research);
    expect(snapshot('plan')).toBeUndefined();
    const locked = `${research}\n- plan 已锁定\n`;
    fs.writeFileSync(path.join(dir, 'Research.md'), locked);
    recorder.record();
    expect(snapshot('plan')).toBe(locked);
    expect(snapshot('research')).toBe(research);

    fs.writeFileSync(path.join(dir, 'Tickets.md'), read('Tickets.md'));
    recorder.record();
    expect(snapshot('tickets')).toBe(read('Tickets.md'));
  });
});
