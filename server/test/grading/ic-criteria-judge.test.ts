import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import {
  branchFrom,
  checksFrom,
  descriptionFrom,
  endpointFrom,
  latestPrFrom,
  prInfoFrom,
} from '../../src/external/github.js';
import { judgeIcCriteria } from '../../src/grading/ic-criteria.js';
import { loadIcTask, syncTasks } from '../../src/tasks/loader.js';
import { withoutHiddenTests } from '../helpers/ic-fixture.js';
import { recordedPr } from '../helpers/gh-fixtures.js';
import { openTestDb } from '../stages/db.js';

const { db, close } = openTestDb();
afterAll(close);
syncTasks(db, config.tasksDir);

// 录下的真实 PR（scripts/record-gh-fixtures.ts）：ic-money-format 的起始仓库副本上，以 task 的参考实现开出的 PR，ci 通过
const recorded = recordedPr('criteria-judge');

describe('验收标准 judge（真实 gateway，录下的 PR）', { timeout: 20 * 60_000 }, () => {
  it('ic-money-format 去掉隐藏测试：参考实现的 PR 逐条评分', async () => {
    const source = loadIcTask(db, 'ic-money-format');
    const task = { ...withoutHiddenTests(source, 'w28-criteria-task'), dir: source.dir };
    const latest = latestPrFrom(recorded.stdout('list'));
    if (latest === null) throw new Error('criteria-judge 的录制中没有 PR');
    const checks = checksFrom(recorded.repo, recorded.pr(), recorded.result('checks'));
    const diff = recorded.stdout('diff');
    const started = Date.now();
    const result = await judgeIcCriteria(
      task,
      {
        pr: prInfoFrom(latest, checks),
        branch: branchFrom(recorded.stdout('branch')),
        description: descriptionFrom(recorded.stdout('description')),
        diff,
        checks,
        endpoint: endpointFrom(recorded.stdout('endpoint'), checks, task.requiredChecks),
      },
      new AbortController().signal,
    );
    const out = path.join(config.repoRoot, '.work/grading');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'ic-criteria-grades.json'), JSON.stringify(result, null, 2));
    expect(result.items.map((i) => i.itemId)).toEqual(['ac1', 'ac2', 'ac3', 'ac4', 'ac5']);
    expect(result.items.map((i) => i.criterion)).toEqual(task.ticket.acceptanceCriteria);
    for (const item of result.items) {
      expect([0, 1, 2]).toContain(item.score);
      expect(item.maxScore).toBe(2);
      expect(item.reasoning.length).toBeGreaterThan(10);
    }
    // 参考实现满足前四条的行为；它不加单元测试，第 5 条（新增的单元测试）不能满分
    expect(result.items.slice(0, 4).every((i) => i.score >= 1)).toBe(true);
    expect(result.items[4]?.score).toBeLessThan(2);
    expect(result.detail.pr).toMatchObject({ number: 1, head: latest.headRefOid });
    expect(result.detail.checks.map((c) => [c.name, c.bucket])).toEqual([['ci', 'pass']]);
    expect(result.detail.endpoint).toMatchObject({ reached: true, missingRequired: [] });
    expect(result.detail.diffChars).toBe(diff.length);
    expect(result.reachedEnd).toBe(true);
    expect(result.judge?.costUsd).toBeGreaterThan(0);
    const score = result.items.reduce((sum, i) => sum + i.score, 0);
    console.log(
      `评分 ${String(Math.round((Date.now() - started) / 1000))} 秒；验收标准 ${String(score)} / 10，${String(result.judge?.model)}，输入 ${String(result.judge?.usage.inputTokens)} 输出 ${String(result.judge?.usage.outputTokens)} token，花费 $${String(result.judge?.costUsd.toFixed(4))}`,
    );
    for (const item of result.items) {
      console.log(`${item.itemId} ${String(item.score)}/2 ${item.reasoning}`);
    }
  });
});
