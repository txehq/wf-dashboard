import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { clonePr, icEndpoint, prBranch, readPr } from '../external/github.js';
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

// 仓库中最新的 PR：隐藏测试跑在 PR 分支的 head 上，终点判定读同一个 head；没有 PR 时测试记 0 / 声明数；
// 隐藏测试的评分错误（例如超时）记在 detail.error，测试记 0 / 声明数；signal 取消时在下一步之前抛出 signal.reason
export async function gradeIc(
  task: IcTask,
  runId: string,
  repo: string,
  signal: AbortSignal,
): Promise<IcGrade> {
  const pr = await readPr(repo);
  signal.throwIfAborted();
  if (pr === null) {
    const outcomes = Object.entries(task.hiddenTests.manifest).flatMap(([file, names]) =>
      names.map((name) => ({ file, name, outcome: 'not-run' as const })),
    );
    return {
      testsPassed: 0,
      testsDeclared: outcomes.length,
      reachedEnd: false,
      detail: { pr: null, outcomes, fileErrors: [], endpoint: null, error: null },
    };
  }
  const branch = await prBranch(repo, pr.number);
  const checkout = gradingCheckout(runId);
  const { head } = await clonePr(repo, pr.number, checkout);
  const tests = await runHiddenTests(checkout, task, signal);
  const endpoint = await icEndpoint(repo, pr.number);
  signal.throwIfAborted();
  if (endpoint.head !== head) {
    throw new Error(
      `${repo}#${String(pr.number)} 的 head 在评分期间变化：${head} → ${endpoint.head}`,
    );
  }
  // 评分写出后删除 checkout（含 node_modules）与评分用的 HOME；JUnit、日志与测试配置留在 grading/ 下。
  // 评分出错时保留，供排查
  if (tests.error === null) {
    const gradingDir = path.dirname(checkout);
    fs.rmSync(checkout, { recursive: true });
    fs.rmSync(path.join(gradingDir, 'home'), { recursive: true });
    fs.rmSync(path.join(gradingDir, 'tmp'), { recursive: true });
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
      error: tests.error,
    },
  };
}
