import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import YAML from 'yaml';
import { config } from '../../src/config.js';
import { ciRuleset, COPY_COMMIT_TITLE, repoCreateArgs } from '../../src/external/github.js';
import { loadIcTask, syncTasks } from '../../src/tasks/loader.js';
import type { IcTask } from '../../src/tasks/schema.js';
import { CALC_CI_IN_COPY, createCalcStartRepo } from '../helpers/calc-repo.js';
import { git, testRunId } from '../helpers/ic-fixture.js';
import { testRepos } from '../helpers/local-repos.js';
import { openTestDb } from '../stages/db.js';

// Contracts 第 13 节"CI 与终点"：副本中只保留 pull_request 与 workflow_call 触发的 workflow。副本推送到本地 bare 仓库
// （本地仓库模式，Contracts 7.2），与推送到 GitHub 用同一个准备函数；clone 出来检查推送后的内容与提交信息
const repos = testRepos();

async function cloneCopy(repo: string, name: string) {
  const dest = path.join(config.repoRoot, '.work/test-tasks', testRunId(name), 'clone');
  await execa('git', ['clone', '--quiet', repo, dest]);
  const show = async (format: string) =>
    (await execa('git', ['-C', dest, 'log', '-1', `--format=${format}`])).stdout;
  return {
    dest,
    workflows: () => fs.readdirSync(path.join(dest, '.github/workflows')).sort(),
    file: (p: string) => fs.readFileSync(path.join(dest, p), 'utf8'),
    head: () => show('%H'),
    parents: () => show('%P'),
    author: () => show('%an <%ae>'),
    // %B 在提交信息之后另加一个换行
    message: async () => (await show('%B')).trimEnd(),
    count: async () => (await execa('git', ['-C', dest, 'rev-list', '--count', 'HEAD'])).stdout,
  };
}

async function bundleTask(source: string, ref: string, name: string): Promise<string> {
  const taskDir = path.join(config.repoRoot, '.work/test-tasks', testRunId(name), 'task');
  fs.mkdirSync(taskDir, { recursive: true });
  await git(source, ['bundle', 'create', path.join(taskDir, 'repo.bundle'), ref]);
  return taskDir;
}

const calcTask = (dir: string, commit: string): IcTask => ({
  id: 'ic-txe-3777',
  kind: 'ic',
  dir,
  title: 't',
  persona: 'p',
  hiddenRequirements: 'h',
  ticket: { title: 't', body: 'b', acceptanceCriteria: ['a'] },
  repo: { path: 'repo.bundle', commit },
  requiredChecks: ['ci', 'self-hosted-echo'],
});

// 克隆 txe-workflow 的全部历史与多次 git 推送：全量并行运行时单个用例会超过 vitest 默认的 5 秒
describe('副本仓库只保留 pull_request 的 workflow（本地 bare 仓库）', { timeout: 60_000 }, () => {
  it('calc 仓库：scheduled-echo 删除、ci 只删去 push 两行、self-hosted-echo 原样；wf-dashboard 提交，seed 删除', async () => {
    const calc = await createCalcStartRepo({ ciOnPush: true });
    const task = calcTask(await bundleTask(calc.local, 'main', 'w29-copy'), calc.workflowsCommit);
    const runId = testRunId('test-copy');
    const created = await repos.createCopy(task, runId, new AbortController().signal);
    expect(created.repo).toBe(path.join(String(config.localReposDir), `wfe-${runId}.git`));
    expect(created.url).toBe(`file://${created.repo}`);
    expect(fs.existsSync(path.join(config.runsDir, runId, 'seed'))).toBe(false);

    const clone = await cloneCopy(created.repo, 'w29-copy-clone');
    expect(await clone.head()).toBe(created.mainSha);
    expect(await clone.parents()).toBe(calc.workflowsCommit);
    expect(await clone.author()).toBe('wf-dashboard <wf-dashboard@users.noreply.github.com>');
    expect(await clone.message()).toBe(
      `${COPY_COMMIT_TITLE}\n\n- .github/workflows/ci.yml：去掉 push\n- 删除 .github/workflows/scheduled-echo.yml（触发方式：schedule、workflow_dispatch）`,
    );
    expect(clone.workflows()).toEqual(['ci.yml', 'self-hosted-echo.yml']);
    expect(clone.file('.github/workflows/ci.yml')).toBe(CALC_CI_IN_COPY);
    expect(clone.file('.github/workflows/self-hosted-echo.yml')).toBe(
      calc.workflows['self-hosted-echo.yml'],
    );
    expect(clone.file('README.md')).toBe('# 初中机房离线网页计算器\n');
  });

  it('没有要改的 workflow：不加 commit，main 就是起始 commit', async () => {
    const calc = await createCalcStartRepo();
    const task = calcTask(await bundleTask(calc.local, 'main', 'w29-noop'), calc.readmeCommit);
    const created = await repos.createCopy(
      task,
      testRunId('test-copy-noop'),
      new AbortController().signal,
    );
    expect(created.mainSha).toBe(calc.readmeCommit);
    const clone = await cloneCopy(created.repo, 'w29-noop-clone');
    expect(await clone.count()).toBe('1');
  });

  it('ic-money-format：ci 的 push 触发被去掉，pull_request 保留', async () => {
    const { db, close } = openTestDb();
    syncTasks(db, config.tasksDir);
    const task = loadIcTask(db, 'ic-money-format');
    close();
    const created = await repos.createCopy(
      task,
      testRunId('test-copy-money'),
      new AbortController().signal,
    );
    const clone = await cloneCopy(created.repo, 'w29-money-clone');
    expect(await clone.parents()).toBe(task.repo.commit);
    const on = (YAML.parse(clone.file('.github/workflows/ci.yml')) as { on: unknown }).on;
    expect(Object.keys(on as object)).toEqual(['pull_request']);
  });

  it('txe-workflow 9f2bed6（真实仓库的本地 clone）：ci 去掉 workflow_dispatch 并保留注释，release 删除', async () => {
    const source = path.join(config.repoRoot, '.work/test-tasks', testRunId('w32-txe'), 'source');
    await execa('git', ['clone', '--quiet', '--no-checkout', config.txeWorkflowRepo, source]);
    const commit = '9f2bed6fbdcef9e30a9a773a95bc5a9d618016ff';
    await git(source, ['update-ref', 'refs/heads/eval-start', commit]);
    const task = { ...calcTask(await bundleTask(source, 'eval-start', 'w32-txe'), commit) };
    const created = await repos.createCopy(
      task,
      testRunId('test-copy-txe'),
      new AbortController().signal,
    );
    const clone = await cloneCopy(created.repo, 'w32-txe-clone');
    expect(await clone.parents()).toBe(commit);
    expect(clone.workflows()).toEqual(['ci.yml']);
    expect(await clone.message()).toBe(
      `${COPY_COMMIT_TITLE}\n\n- .github/workflows/ci.yml：去掉 workflow_dispatch\n- 删除 .github/workflows/release.yml（触发方式：push、workflow_dispatch）`,
    );
    const original = (await git(source, ['show', `${commit}:.github/workflows/ci.yml`])).stdout;
    const copied = clone.file('.github/workflows/ci.yml');
    expect(Object.keys((YAML.parse(copied) as { on: object }).on)).toEqual(['pull_request']);
    // 注释与 jobs 部分逐字节不变
    expect(copied).toContain(
      '# The fast gate: everything that does not need two platforms runs once',
    );
    expect(copied.slice(copied.indexOf('\njobs:'))).toBe(
      `${original.slice(original.indexOf('\njobs:'))}\n`,
    );
  });

  it('建仓库的参数与 ruleset：名字 txehq/wfe-<runId>，导入的 task 不带 task id；requiredChecks 只认 Actions 报告的 check', () => {
    const task = calcTask('/nonexistent', 'a'.repeat(40));
    const runId = 'r-20261012-abc123';
    expect(repoCreateArgs(task, runId)).toEqual([
      'repo',
      'create',
      'txehq/wfe-r-20261012-abc123',
      '--private',
      '--description',
      'wf-dashboard eval run r-20261012-abc123 (ic-txe-3777)',
    ]);
    const imported: IcTask = {
      ...task,
      source: {
        linear: { identifier: 'TXE-3777', url: 'https://linear.app/capso/issue/TXE-3777' },
        github: { repo: 'txehq/source', prs: [] },
      },
    };
    expect(repoCreateArgs(imported, runId).at(-1)).toBe('wf-dashboard eval run r-20261012-abc123');
    expect(repoCreateArgs(null, runId).at(-1)).toBe('wf-dashboard eval run r-20261012-abc123');
    expect(ciRuleset(task.requiredChecks)).toEqual({
      name: 'ci-required',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
      rules: [
        {
          type: 'required_status_checks',
          parameters: {
            strict_required_status_checks_policy: false,
            do_not_enforce_on_create: false,
            required_status_checks: [
              { context: 'ci', integration_id: 15368 },
              { context: 'self-hosted-echo', integration_id: 15368 },
            ],
          },
        },
      ],
    });
  });
});
