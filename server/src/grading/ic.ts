import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import {
  clonePr,
  type IcEndpoint,
  icEndpoint,
  prBranch,
  type PrInfo,
  readPr,
} from '../external/github.js';
import type { IcTaskWithTests } from '../tasks/schema.js';
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
// agent 的代码造成的失败（例如超时、npm ci 失败）记在 detail.error，测试记 0 / 声明数；signal 取消时在下一步之前抛出 signal.reason
export async function gradeIc(
  task: IcTaskWithTests,
  runId: string,
  repo: string,
  signal: AbortSignal,
): Promise<IcGrade> {
  const pr = await readPr(repo);
  signal.throwIfAborted();
  if (pr === null) return noPrIcGrade(task);
  const branch = await prBranch(repo, pr.number);
  return gradeIcPr(
    task,
    runId,
    { pr, branch },
    {
      checkout: (dest) => clonePr(repo, pr.number, dest),
      endpoint: () => icEndpoint(repo, pr.number, task.requiredChecks),
    },
    signal,
  );
}

export function noPrIcGrade(task: IcTaskWithTests): IcGrade {
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

export interface PrSource {
  // 把 PR 的 head 取到 dest
  checkout: (dest: string) => Promise<{ head: string }>;
  // 隐藏测试之后读的终点判定
  endpoint: () => Promise<IcEndpoint>;
}

// 已读到的 PR：checkout 到 data/runs/<runId>/grading/checkout 跑隐藏测试，再判定终点
export async function gradeIcPr(
  task: IcTaskWithTests,
  runId: string,
  read: { pr: PrInfo; branch: string },
  source: PrSource,
  signal: AbortSignal,
): Promise<IcGrade> {
  const { pr, branch } = read;
  const checkout = gradingCheckout(runId);
  const { head } = await source.checkout(checkout);
  const tests = await runHiddenTests(checkout, task, signal);
  const endpoint = await source.endpoint();
  signal.throwIfAborted();
  if (endpoint.head !== head) {
    throw new Error(`${pr.url} 的 head 在评分期间变化：${head} → ${endpoint.head}`);
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
