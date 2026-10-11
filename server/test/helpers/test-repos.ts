import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { config } from '../../src/config.js';
import { createRunRepo, runRepoName, waitRuns } from '../../src/external/github.js';
import type { IcTask } from '../../src/tasks/schema.js';
import { git, testRunId } from './ic-fixture.js';

// 测试运行时现建的 txehq 仓库：用户会定期删除不再更新的 wfe-* 仓库，测试不依赖任何已存在的评测仓库。
// 名字为 wfe-test-<用途>-<时间戳>，afterAll 中只删除本次测试建的仓库
const created: string[] = [];

const TEST_REPO = /^txehq\/wfe-test-[a-z0-9-]+-\d{17}$/;

const gh = async (args: string[], cwd?: string) =>
  (await execa('gh', args, cwd === undefined ? {} : { cwd })).stdout.trim();

// 起始代码推送后的 CI 通过，ruleset 以 task 的 requiredChecks 建好；没有 PR
export async function repoWithoutPr(task: IcTask, purpose: string): Promise<string> {
  const runId = testRunId(`test-${purpose}`);
  // createRunRepo 在 gh repo create 之后才可能失败，先记下名字，失败时也会被删除
  created.push(runRepoName(runId));
  const repo = await createRunRepo(task, runId, new AbortController().signal);
  return repo.repo;
}

// 在起始仓库上把 changes 目录（结构与仓库一致）覆盖进一个分支，开 PR、标为 ready，等 PR 的 CI 结束
export async function repoWithReadyPr(
  task: IcTask,
  purpose: string,
  changes: string,
  message: string,
): Promise<{ repo: string; pr: number; url: string; branch: string; head: string }> {
  const repo = await repoWithoutPr(task, purpose);
  const work = path.join(config.repoRoot, '.work/test-tasks', repo.replace('/', '__'), 'agent');
  fs.rmSync(work, { recursive: true, force: true });
  await gh(['repo', 'clone', repo, work]);
  const branch = 'feat/test-change';
  await git(work, ['checkout', '-b', branch]);
  fs.cpSync(changes, work, { recursive: true });
  await git(work, ['add', '-A']);
  await git(work, ['commit', '-m', message]);
  await git(work, ['push', '-u', 'origin', branch]);
  const url = await gh(
    ['pr', 'create', '--repo', repo, '--head', branch, '--title', message, '--body', message],
    work,
  );
  const pr = Number(url.split('/').pop());
  await gh(['pr', 'ready', String(pr), '--repo', repo]);
  const head = (await git(work, ['rev-parse', 'HEAD'])).stdout.trim();
  await waitRuns(repo, head, new AbortController().signal);
  return { repo, pr, url, branch, head };
}

export async function deleteTestRepos() {
  for (const repo of created.splice(0)) {
    if (!TEST_REPO.test(repo)) throw new Error(`不是本次测试建的仓库，不删除：${repo}`);
    const exists = await execa('gh', ['repo', 'view', repo, '--json', 'name'], { reject: false });
    if (exists.exitCode === 0) await gh(['repo', 'delete', repo, '--yes']);
  }
}
