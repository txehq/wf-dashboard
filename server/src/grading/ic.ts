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
import type { TestsTask } from '../tasks/schema.js';
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

// Latest PR in the repo: hidden tests run on the PR branch head and the endpoint check reads the same head; without a PR tests score 0 / declared;
// failures caused by the agent's code (e.g. timeout, npm ci failure) go to detail.error and score 0 / declared; on signal abort, throw signal.reason before the next step
export async function gradeIc(
  task: TestsTask,
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

export function noPrIcGrade(task: TestsTask): IcGrade {
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
  // Fetch the PR head into dest
  checkout: (dest: string) => Promise<{ head: string }>;
  // Endpoint check read after the hidden tests
  endpoint: () => Promise<IcEndpoint>;
}

// A PR already read: check out to data/runs/<runId>/grading/checkout, run hidden tests, then check the endpoint
export async function gradeIcPr(
  task: TestsTask,
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
    throw new Error(`Head of ${pr.url} changed during grading: ${head} → ${endpoint.head}`);
  }
  // After the grade is written, delete the checkout (with node_modules) and the grading HOME; JUnit, logs and test config stay under grading/.
  // Kept when grading errored, for debugging
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
