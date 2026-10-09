import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import { runTicketDescription } from '../src/external/linear.js';
import { runHiddenTests } from '../src/grading/hidden-tests.js';
import { buildFixtureTask, fixtureDir, git, testRunId } from './helpers/ic-fixture.js';

// 不经过 GitHub：从 task 的 bundle 本地 clone，提交与 PR 相同的改动，再在其上运行隐藏测试
describe('隐藏测试（本地 fixture 仓库）', { timeout: 5 * 60_000 }, () => {
  it('runHiddenTests：通过 3 / 声明 8，文件级错误与未运行的测试计入分母', async () => {
    const runId = testRunId('w7-local');
    const task = await buildFixtureTask(runId);
    const checkout = path.join(config.runsDir, runId, 'grading/checkout');
    await git(config.repoRoot, ['clone', path.join(task.dir, task.repo.path), checkout]);
    await git(checkout, ['checkout', '-b', 'feat/subtract', task.repo.commit]);
    fs.cpSync(path.join(fixtureDir, 'pr'), checkout, { recursive: true });
    await git(checkout, ['add', '-A']);
    await git(checkout, ['commit', '-m', 'feat: subtract']);
    const head = (await git(checkout, ['rev-parse', 'HEAD'])).stdout.trim();

    const result = await runHiddenTests(checkout, task);
    expect(result.junitPath).toBe(path.join(config.runsDir, runId, 'grading/junit.xml'));
    expect(result.head).toBe(head);
    expect(result.declared).toBe(8);
    expect(result.passed).toBe(3);
    expect(result.fileErrors).toHaveLength(1);
    expect(result.fileErrors[0]?.file).toBe('test/hidden/divide.hidden.test.js');
    expect(result.fileErrors[0]?.message).toContain("Cannot find module '../../src/divide.js'");
    expect(result.outcomes.map((o) => [o.name, o.outcome])).toEqual([
      ['subtract(5, 3) returns 2', 'passed'],
      ['subtract handles negatives', 'passed'],
      ['add still works', 'passed'],
      ['subtract(0.3, 0.1) returns exactly 0.2', 'failed'],
      ['multiply(2, 3) returns 6', 'failed'],
      ['multiply by zero', 'failed'],
      ['divide(6, 3) returns 2', 'not-run'],
      ['divide by one', 'not-run'],
    ]);
    // 同一个 checkout 不能评分两次
    await expect(runHiddenTests(checkout, task)).rejects.toThrow('已存在');
  });

  it('工单正文：ticket 正文、验收标准清单，末尾 run id', async () => {
    const task = await buildFixtureTask(testRunId('w7-desc'));
    expect(runTicketDescription(task, 'r1')).toBe(
      [
        '在 `src/math.js` 中导出 `subtract(a, b)`，返回 `a - b`。',
        '',
        '## Acceptance criteria',
        '',
        '- [ ] AC1 `subtract(5, 3)` 返回 `2` — verify: test',
        '- [ ] AC2 CI 通过 — verify: CI',
        '',
        'run id: `r1`',
      ].join('\n'),
    );
  });
});
