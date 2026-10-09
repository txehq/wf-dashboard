import { randomUUID } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import {
  applyReference,
  checkoutStartRepo,
  installDependencies,
  placeHiddenTests,
  runHiddenTestCases,
  scoreAgainstManifest,
} from '../src/tasks/ic.js';
import { loadIcTask, syncTasks } from '../src/tasks/loader.js';

const workDir = path.join(config.repoRoot, '.work', 'test-ic', randomUUID());
const db = openDatabase(path.join(workDir, 'db.sqlite'), config.migrationsDir);
syncTasks(db, config.tasksDir);

afterAll(() => {
  db.$client.close();
  rmSync(workDir, { recursive: true, force: true });
});

const icIds = readdirSync(config.tasksDir).filter((id) => id.startsWith('ic-'));

// 每个 ic task：从 bundle clone 起始仓库，真实运行隐藏测试（npm ci + vitest）
describe.concurrent.each(icIds)('%s', (id) => {
  test('起始仓库停在固定 commit，隐藏测试有失败；应用参考实现后按清单全部通过', async () => {
    const task = loadIcTask(db, id);
    const declared = Object.values(task.hiddenTests.manifest).flat().length;

    const start = path.join(workDir, id, 'start');
    expect(checkoutStartRepo(task, start)).toBe(task.repo.commit);
    installDependencies(start);
    placeHiddenTests(task, start);
    const startRun = await runHiddenTestCases(task, start, path.join(workDir, id, 'start.xml'));
    const startScore = scoreAgainstManifest(startRun, task.hiddenTests.manifest);
    expect(startRun.exitCode).toBe(1);
    expect(startScore.declared).toBe(declared);
    expect(startScore.passed).toBeLessThan(declared);

    const reference = path.join(workDir, id, 'reference');
    checkoutStartRepo(task, reference);
    installDependencies(reference);
    applyReference(task, reference);
    placeHiddenTests(task, reference);
    const referenceRun = await runHiddenTestCases(
      task,
      reference,
      path.join(workDir, id, 'reference.xml'),
    );
    const referenceScore = scoreAgainstManifest(referenceRun, task.hiddenTests.manifest);
    expect(referenceRun.exitCode).toBe(0);
    expect(referenceRun.fileErrors).toEqual([]);
    expect(referenceScore.outcomes.filter((o) => o.outcome !== 'passed')).toEqual([]);
    expect(referenceScore.passed).toBe(declared);
  }, 300_000);
});
