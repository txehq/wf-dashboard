import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import {
  COPY_COMMIT_TITLE,
  createRunRepo,
  icEndpoint,
  prChecks,
  runRepoName,
  waitRuns,
} from '../../src/external/github.js';
import { loadIcTask, syncTasks } from '../../src/tasks/loader.js';
import type { IcTask } from '../../src/tasks/schema.js';
import { CALC_CI_IN_COPY, createCalcStartRepo } from '../helpers/calc-repo.js';
import { git, testRunId } from '../helpers/ic-fixture.js';
import { openReadyPr, repoWithReadyPr } from '../helpers/test-repos.js';
import { openTestDb } from '../stages/db.js';

// Contracts 第 13 节"CI 与终点"：副本中只运行由 pull_request 触发的 workflow。真实 GitHub：测试新建的仓库不删除，
// 由用户清理
const gh = async (args: string[]) => (await execa('gh', args)).stdout.trim();

async function rawFile(repo: string, file: string): Promise<string> {
  return gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${file}`]);
}

// 把一个 PR 的改动目录写成只改 README 的样子
function readmeChange(name: string): string {
  const dir = path.join(config.repoRoot, '.work/test-tasks', testRunId(name), 'changes');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'README.md'),
    '# 初中机房离线网页计算器\n\n只改 README 的 PR。\n',
  );
  return dir;
}

describe('副本仓库只保留 pull_request 的 workflow（真实 GitHub）', { timeout: 20 * 60_000 }, () => {
  it('calc 仓库：scheduled-echo 删除、ci 只剩 pull_request，推送后 2 分钟没有 run；PR 上 ci 与 self-hosted-echo 运行并有结论', async () => {
    const calc = await createCalcStartRepo({ ciOnPush: true });
    const taskDir = path.join(config.repoRoot, '.work/test-tasks', testRunId('w29-copy'), 'task');
    fs.mkdirSync(taskDir, { recursive: true });
    await git(calc.local, ['bundle', 'create', path.join(taskDir, 'repo.bundle'), 'main']);
    const task: IcTask = {
      id: 'ic-txe-3777',
      kind: 'ic',
      dir: taskDir,
      title: 't',
      persona: 'p',
      hiddenRequirements: 'h',
      ticket: { title: 't', body: 'b', acceptanceCriteria: ['a'] },
      repo: { path: 'repo.bundle', commit: calc.workflowsCommit },
      requiredChecks: ['ci', 'self-hosted-echo'],
    };
    const runId = testRunId('test-copy');
    console.log(`测试仓库 ${runRepoName(runId)}`);
    const created = await createRunRepo(task, runId, new AbortController().signal);
    const pushedAt = Date.now();
    const repo = created.repo;

    // main 是 wf-dashboard 加在起始 commit 之上的一个 commit
    const head = JSON.parse(await gh(['api', `repos/${repo}/commits/${created.mainSha}`])) as {
      parents: { sha: string }[];
      commit: { message: string; author: { name: string } };
    };
    expect(head.parents.map((p) => p.sha)).toEqual([calc.workflowsCommit]);
    expect(head.commit.author.name).toBe('wf-dashboard');
    expect(head.commit.message).toBe(
      `${COPY_COMMIT_TITLE}\n\n- .github/workflows/ci.yml：去掉 push\n- 删除 .github/workflows/scheduled-echo.yml（触发方式：schedule、workflow_dispatch）`,
    );
    // 读回文件：scheduled-echo 不存在；ci 只删去 push 的两行，注释与其余字节不变；self-hosted-echo 原样
    const names = JSON.parse(
      await gh(['api', `repos/${repo}/contents/.github/workflows`, '--jq', '[.[].name]']),
    ) as string[];
    expect(names).toEqual(['ci.yml', 'self-hosted-echo.yml']);
    expect(`${await rawFile(repo, '.github/workflows/ci.yml')}\n`).toBe(CALC_CI_IN_COPY);
    expect(`${await rawFile(repo, '.github/workflows/self-hosted-echo.yml')}\n`).toBe(
      calc.workflows['self-hosted-echo.yml'],
    );

    // 推送后 2 分钟内没有任何 run
    while (Date.now() - pushedAt < 120_000) {
      expect(await gh(['api', `repos/${repo}/actions/runs`, '--jq', '.total_count'])).toBe('0');
      await sleep(15_000);
    }

    // 只改 README 的 PR：ci 与 self-hosted-echo 运行并有结论，终点到达
    const pr = await openReadyPr(repo, readmeChange('w29-copy-pr'), 'docs: readme');
    const runs = await waitRuns(repo, pr.head, new AbortController().signal);
    expect(runs.map((r) => [r.name, r.event, r.status]).sort()).toEqual([
      ['ci', 'pull_request', 'completed'],
      ['self-hosted-echo', 'pull_request', 'completed'],
    ]);
    // GitHub 登记 workflow 的时间不定（推送后 2 分钟仍可能为空）；PR 的 run 结束后登记的只有这两个
    const registered = JSON.parse(
      await gh(['api', `repos/${repo}/actions/workflows`, '--jq', '[.workflows[].path]']),
    ) as string[];
    expect(registered.sort()).toEqual([
      '.github/workflows/ci.yml',
      '.github/workflows/self-hosted-echo.yml',
    ]);
    const checks = await prChecks(repo, pr.pr);
    expect(checks.map((c) => [c.name, c.bucket]).sort()).toEqual([
      ['ci', 'pass'],
      ['self-hosted-echo', 'pass'],
    ]);
    expect(await icEndpoint(repo, pr.pr, task.requiredChecks)).toMatchObject({
      reached: true,
      missingRequired: [],
    });
    console.log(`PR ${pr.url}`);
  });

  it('ic-money-format：ci 的 push 触发被去掉，PR 上 ci 照常运行并通过', async () => {
    const { db, close } = openTestDb();
    syncTasks(db, config.tasksDir);
    const task = loadIcTask(db, 'ic-money-format');
    close();
    const created = await repoWithReadyPr(
      task,
      'copy-money',
      readmeChange('w29-copy-money'),
      'docs: readme',
    );
    const ci = await rawFile(created.repo, '.github/workflows/ci.yml');
    expect(ci).toContain('pull_request');
    expect(ci).not.toMatch(/^\s+push:/m);
    const checks = await prChecks(created.repo, created.pr);
    expect(checks.map((c) => [c.name, c.bucket])).toEqual([['ci', 'pass']]);
    expect(await icEndpoint(created.repo, created.pr, task.requiredChecks)).toMatchObject({
      reached: true,
    });
    console.log(`PR ${created.url}`);
  });
});
