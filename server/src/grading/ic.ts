import path from 'node:path';
import { config } from '../config.js';
import { clonePrBranch, icEndpoint, prBranch, readPr } from '../external/github.js';
import type { IcTask } from '../tasks/schema.js';
import { runHiddenTests } from './hidden-tests.js';
import type { IcDetail } from './schema.js';

export interface IcGrade {
  testsPassed: number;
  testsDeclared: number;
  reachedEnd: boolean;
  detail: IcDetail;
}

export const gradingCheckout = (runId: string) =>
  path.join(config.runsDir, runId, 'grading/checkout');

// 仓库中最新的 PR：隐藏测试跑在 PR 分支的 head 上，终点判定读同一个 head；没有 PR 时测试记 0 / 声明数
export async function gradeIc(task: IcTask, runId: string, repo: string): Promise<IcGrade> {
  const pr = await readPr(repo);
  if (pr === null) {
    const outcomes = Object.entries(task.hiddenTests.manifest).flatMap(([file, names]) =>
      names.map((name) => ({ file, name, outcome: 'not-run' as const })),
    );
    return {
      testsPassed: 0,
      testsDeclared: outcomes.length,
      reachedEnd: false,
      detail: { pr: null, outcomes, fileErrors: [], endpoint: null },
    };
  }
  const branch = await prBranch(repo, pr.number);
  const checkout = gradingCheckout(runId);
  const { head } = await clonePrBranch(repo, branch, checkout);
  const tests = await runHiddenTests(checkout, task);
  const endpoint = await icEndpoint(repo, pr.number);
  if (endpoint.head !== head) {
    throw new Error(
      `${repo}#${String(pr.number)} 的 head 在评分期间变化：${head} → ${endpoint.head}`,
    );
  }
  return {
    testsPassed: tests.passed,
    testsDeclared: tests.declared,
    reachedEnd: endpoint.reached,
    detail: {
      pr: { number: pr.number, url: pr.url, branch, head },
      outcomes: tests.outcomes,
      fileErrors: tests.fileErrors,
      endpoint,
    },
  };
}
