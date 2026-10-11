import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { config } from '../src/config.js';
import {
  clonePr,
  createEmptyRunRepo,
  createRunRepo,
  icEndpoint,
  readPr,
  requiredContexts,
  waitRuns,
} from '../src/external/github.js';
import type { IcTaskWithTests } from '../src/tasks/schema.js';
import { runHiddenTests } from '../src/grading/hidden-tests.js';
import { DEFAULT_COPY_RUNNER_LABELS } from '../src/runs/settings.js';
import { buildFixtureTask, fixtureDir, git, testRunId } from './helpers/ic-fixture.js';

const gh = async (args: string[], cwd?: string) =>
  (await execa('gh', args, cwd === undefined ? {} : { cwd })).stdout.trim();

async function openPr(repo: string, work: string, branch: string, flags: string[], body: string) {
  await git(work, ['push', '-u', 'origin', branch]);
  const title = (await git(work, ['log', '-1', '--format=%s'])).stdout.trim();
  const url = await gh(
    ['pr', 'create', '--repo', repo, '--head', branch, '--title', title, '--body', body, ...flags],
    work,
  );
  console.log(`PR ${url}`);
  return { url, number: Number(url.split('/').pop()) };
}

// 每个 it 依赖前一个建出的仓库与 PR，按顺序执行
describe('GitHub /ic 运行仓库', { timeout: 15 * 60_000 }, () => {
  const runId = testRunId('w7');
  const work = path.join(config.repoRoot, '.work/test-tasks', runId, 'agent');
  const branch = 'feat/subtract';
  let task: IcTaskWithTests;
  let repo: string;
  let pr: number;
  let prHead: string;

  it('createRunRepo：推送 bundle 的固定 commit，push CI 通过，ruleset 生效', async () => {
    task = await buildFixtureTask(runId);
    const created = await createRunRepo(
      task,
      runId,
      DEFAULT_COPY_RUNNER_LABELS,
      new AbortController().signal,
    );
    repo = created.repo;
    console.log(`GitHub 仓库 ${created.url}`);
    expect(repo).toBe(`txehq/wfe-${runId}`);
    expect(created.mainSha).toBe(task.repo.commit);
    expect(created.url).toBe(`https://github.com/${repo}`);
    // W15 Medium 18：推送之后删除本地的 seed.git
    expect(fs.existsSync(path.join(config.runsDir, runId, 'seed.git'))).toBe(false);
    const runs = await waitRuns(repo, created.mainSha, new AbortController().signal);
    expect(runs.map((r) => [r.event, r.conclusion])).toEqual([['push', 'success']]);
    console.log(`push CI ${runs.map((r) => r.url).join(', ')}`);
    expect(await requiredContexts(repo, 'main')).toEqual(['ci']);
    expect(await readPr(repo)).toBeNull();
  });

  it('ruleset 拒绝直接推送 main', async () => {
    await gh(['repo', 'clone', repo, work]);
    fs.writeFileSync(path.join(work, 'NOTES.md'), 'direct push probe\n');
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-m', 'chore: direct push probe']);
    const push = await execa('git', ['push', 'origin', 'main'], { cwd: work, reject: false });
    expect(push.exitCode).not.toBe(0);
    expect(push.stderr).toContain('GH013');
    expect(push.stderr).toContain('Required status check "ci" is expected');
    await git(work, ['reset', '--hard', 'origin/main']);
  });

  it('icEndpoint：draft PR 未到终点，ready 之后到终点', async () => {
    await git(work, ['checkout', '-b', branch]);
    fs.cpSync(path.join(fixtureDir, 'pr'), work, { recursive: true });
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-m', 'feat: subtract']);
    const opened = await openPr(repo, work, branch, ['--draft'], `W7 集成测试 · ${runId}`);
    pr = opened.number;
    prHead = (await git(work, ['rev-parse', 'HEAD'])).stdout.trim();
    const runs = await waitRuns(repo, prHead, new AbortController().signal);
    expect(runs.map((r) => [r.event, r.conclusion])).toEqual([['pull_request', 'success']]);

    expect(await readPr(repo)).toEqual({
      number: pr,
      url: opened.url,
      isDraft: true,
      head: prHead,
      state: 'OPEN',
      checks: [{ name: 'ci', bucket: 'pass', state: 'SUCCESS' }],
    });
    const draft = { ciGreen: true, head: prHead, missingRequired: [] };
    expect(await icEndpoint(repo, pr, task.requiredChecks)).toEqual({
      ...draft,
      reached: false,
      isDraft: true,
    });

    await gh(['pr', 'ready', String(pr), '--repo', repo]);
    expect(await icEndpoint(repo, pr, task.requiredChecks)).toEqual({
      ...draft,
      reached: true,
      isDraft: false,
    });

    // W15 Medium 14：已关闭的 PR 即使 check 全绿也不算到达终点；之后按 pull/<n>/head 取代码，与分支是否存在无关
    await gh(['pr', 'close', String(pr), '--repo', repo, '--delete-branch']);
    expect(await icEndpoint(repo, pr, task.requiredChecks)).toEqual({
      ...draft,
      reached: false,
      isDraft: false,
    });
  });

  it('runHiddenTests：通过 3 / 声明 8，文件级错误与未运行的测试计入分母', async () => {
    const checkout = path.join(config.runsDir, runId, 'grading/checkout');
    const { head } = await clonePr(repo, pr, checkout);
    expect(head).toBe(prHead);
    const result = await runHiddenTests(checkout, task, new AbortController().signal);
    console.log(`JUnit ${String(result.junitPath)}`);
    expect(result.junitPath).toBe(path.join(config.runsDir, runId, 'grading/junit.xml'));
    expect(result.head).toBe(prHead);
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
  });
});

describe('GitHub /lfg 运行仓库', { timeout: 5 * 60_000 }, () => {
  it('createEmptyRunRepo：一个初始提交，没有 CI 与 ruleset，PR 上 checks 为空', async () => {
    const runId = testRunId('w7-lfg');
    const created = await createEmptyRunRepo(runId, new AbortController().signal);
    console.log(`GitHub 仓库 ${created.url}`);
    const repo = created.repo;
    expect(repo).toBe(`txehq/wfe-${runId}`);
    const commits = await gh(['api', `repos/${repo}/commits`, '--jq', '[.[].sha]']);
    expect(JSON.parse(commits)).toEqual([created.mainSha]);
    expect(await gh(['api', `repos/${repo}/rulesets`, '--jq', 'length'])).toBe('0');
    expect(await requiredContexts(repo, 'main')).toEqual([]);

    // 没有 workflow 的仓库：gh pr checks 报告 "no checks reported"
    const work = path.join(config.repoRoot, '.work/test-tasks', runId, 'agent');
    await gh(['repo', 'clone', repo, work]);
    await git(work, ['checkout', '-b', 'docs/notes']);
    fs.writeFileSync(path.join(work, 'NOTES.md'), 'notes\n');
    await git(work, ['add', '-A']);
    await git(work, ['commit', '-m', 'docs: notes']);
    const opened = await openPr(repo, work, 'docs/notes', [], runId);
    expect(await readPr(repo)).toMatchObject({
      number: opened.number,
      url: opened.url,
      isDraft: false,
      state: 'OPEN',
      checks: [],
    });
    // 终点只看 task 的 requiredChecks（Contracts 第 13 节）：要求 ci 时没有任何 check 不算到达；为空时只要求不是 draft
    expect(await icEndpoint(repo, opened.number, ['ci'])).toMatchObject({
      reached: false,
      ciGreen: false,
      isDraft: false,
      missingRequired: ['ci'],
    });
    expect(await icEndpoint(repo, opened.number, [])).toMatchObject({
      reached: true,
      ciGreen: true,
      isDraft: false,
      missingRequired: [],
    });
  });
});
