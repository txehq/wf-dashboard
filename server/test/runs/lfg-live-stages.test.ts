import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { artifacts, batches, runs, stageSpans, variants } from '../../src/db/schema.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import { LfgLiveStages } from '../../src/runs/live-stages.js';
import { featureDir } from '../../src/stages/lfg.js';
import { syncTasks } from '../../src/tasks/loader.js';
import { unpackRunFixture } from '../helpers/run-fixture.js';
import { openTestDb } from '../stages/db.js';

// lfg run r-20261009-dqva52 的真实 session 与它写出的真实 Brief.md（vault 中 Project Magi Eval 的 feature 目录）
const runId = 'r-20261009-dqva52';
const sessionId = '0188c133-3e7b-4592-a963-fc717cf283de';
const brief = path.join(config.vaultDir, 'Project Magi Eval', 'Features', runId, 'Brief.md');
const work = path.join(config.repoRoot, '.work', 'test-lfg-live', randomUUID());
const jsonl = unpackRunFixture(runId, sessionId, path.join(work, 'projects'));

const { db, close } = openTestDb();
syncTasks(db, config.tasksDir);
const variantId = randomUUID();
db.insert(variants)
  .values({
    id: variantId,
    name: `lfg-live-${variantId.slice(0, 8)}`,
    baseCommit: '0'.repeat(40),
    skillsHash: 'a'.repeat(64),
    version: '0.0.0-eval.aaaaaaaa',
    model: 'opus',
    effort: 'high',
  })
  .run();
db.insert(batches).values({ id: 'b-20261009-lfglive', repeats: 1 }).run();
db.insert(runs)
  .values({
    id: runId,
    batchId: 'b-20261009-lfglive',
    taskId: 'lfg-calculator',
    variantId,
    repeatIndex: 0,
    status: 'running',
    sessionId,
    workspacePath: path.join(work, 'workspace'),
  })
  .run();

const writers: ChildProcess[] = [];
afterAll(() => {
  for (const w of writers) w.kill();
  close();
  fs.rmSync(work, { recursive: true, force: true });
});

async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return check();
}

describe('实时 lfg 判定读 feature 目录', () => {
  // 另一个进程在别的目录中不停地建、写、删文件：macOS 的 FSEvents 在这种负载下会丢弃事件，
  // 产物的出现不能依赖文件系统事件
  test('大量文件写入的同时写出 Brief.md：识别为 interview 完成并记录产物', async () => {
    const flood = path.join(work, 'flood');
    for (let k = 0; k < 8; k++) {
      writers.push(
        spawn('bash', [
          '-c',
          'mkdir -p "$1" && while true; do for j in $(seq 1 200); do echo x > "$1/$j"; done; rm -f "$1"/*; done',
          'flood',
          path.join(flood, String(k)),
        ]),
      );
    }
    const vault = path.join(work, 'vault');
    const dir = featureDir(vault, 'Magi Eval', runId);
    const errors: Error[] = [];
    const stages = new LfgLiveStages(
      {
        db,
        runId,
        sessionId,
        workflow: 'lfg',
        ingest: () => {
          ingestFile(db, jsonl);
        },
        onError: (e) => errors.push(e),
      },
      dir,
    );
    await stages.start();
    // feature 目录在 interview 写出 Brief.md 时才出现
    fs.mkdirSync(dir, { recursive: true });
    const content = fs.readFileSync(brief, 'utf8');
    fs.writeFileSync(path.join(dir, 'Brief.md'), content);

    const briefArtifact = () =>
      db
        .select()
        .from(artifacts)
        .where(and(eq(artifacts.runId, runId), eq(artifacts.kind, 'brief')))
        .get();
    expect(await waitFor(() => briefArtifact() !== undefined || errors.length > 0, 10_000)).toBe(
      true,
    );
    for (const w of writers) w.kill();
    expect(errors).toEqual([]);
    expect(briefArtifact()?.snapshot).toBe(content);
    const interview = db
      .select()
      .from(stageSpans)
      .where(and(eq(stageSpans.sessionId, sessionId), eq(stageSpans.stage, 'interview')))
      .get();
    expect(interview).toMatchObject({ status: 'done', method: 'artifact' });
    await stages.close();
  }, 30_000);
});
