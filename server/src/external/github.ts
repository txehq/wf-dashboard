import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import { config } from '../config.js';
import type { IcTask } from './ic-task.js';

export const ORG = 'txehq';
// GitHub Actions app：只有 Actions 报告的 ci 才满足 required check，同名 commit status 无法冒充
const ACTIONS_INTEGRATION_ID = 15368;
const REQUIRED_CHECK = 'ci';
const RUN_POLL_MS = 5_000;
const RUN_TIMEOUT_MS = 600_000;
const DEFAULT_BRANCH_TIMEOUT_MS = 60_000;

// 非零退出即抛出，错误中带 stderr
async function cmd(file: string, args: string[], options: { cwd?: string; input?: string } = {}) {
  const { stdout } = await execa(file, args, options);
  return stdout;
}

async function ghJson<T>(args: string[], schema: z.ZodType<T>, input?: string): Promise<T> {
  return schema.parse(JSON.parse(await cmd('gh', args, input === undefined ? {} : { input })));
}

export const runRepoName = (runId: string) => `${ORG}/wfe-${runId}`;

export interface RunRepo {
  repo: string;
  url: string;
  mainSha: string;
}

const RepoView = z.object({
  url: z.string(),
  defaultBranchRef: z.object({ name: z.string() }),
});

const Branch = z.object({ commit: z.object({ sha: z.string() }) }).loose();

async function repoView(repo: string) {
  return ghJson(['repo', 'view', repo, '--json', 'url,defaultBranchRef'], RepoView);
}

// 空仓库的 defaultBranchRef 为空；第一次推送后要过几秒才变成 main
async function waitDefaultBranchMain(repo: string) {
  const deadline = Date.now() + DEFAULT_BRANCH_TIMEOUT_MS;
  for (;;) {
    const view = await repoView(repo);
    if (view.defaultBranchRef.name === 'main') return view;
    if (view.defaultBranchRef.name !== '' || Date.now() > deadline) {
      throw new Error(`${repo} 的默认分支是 "${view.defaultBranchRef.name}"，应为 main`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

async function branchSha(repo: string, branch: string): Promise<string> {
  return (await ghJson(['api', `repos/${repo}/branches/${branch}`], Branch)).commit.sha;
}

const Run = z
  .object({
    databaseId: z.number(),
    status: z.string(),
    conclusion: z.string(),
    name: z.string(),
    url: z.string(),
    event: z.string(),
  })
  .loose();
export type WorkflowRun = z.infer<typeof Run>;

// 推送后几秒内列表可能为空，要等到"非空且全部 completed"
export async function waitRuns(repo: string, sha: string): Promise<WorkflowRun[]> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  for (;;) {
    const runs = await ghJson(
      [
        'run',
        'list',
        '--repo',
        repo,
        '--commit',
        sha,
        '--json',
        'databaseId,status,conclusion,name,url,event',
      ],
      z.array(Run),
    );
    if (runs.length > 0 && runs.every((r) => r.status === 'completed')) return runs;
    if (Date.now() > deadline) {
      throw new Error(`${repo}@${sha} 的 workflow run ${String(RUN_TIMEOUT_MS)}ms 内未结束`);
    }
    await new Promise((resolve) => setTimeout(resolve, RUN_POLL_MS));
  }
}

const ciRuleset = {
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
          { context: REQUIRED_CHECK, integration_id: ACTIONS_INTEGRATION_ID },
        ],
      },
    },
  ],
};

// /ic 运行的仓库副本。顺序不能调换：ruleset 生效后直接推送 main 会被拒绝（GH013），
// 所以先推送起始代码、等这次 push 的 CI 结束，最后建 ruleset，agent 只能经 PR 改代码
export async function createRunRepo(task: IcTask, runId: string): Promise<RunRepo> {
  const repo = runRepoName(runId);
  const bundle = path.join(task.dir, task.repo.path);
  const seed = path.join(config.runsDir, runId, 'seed.git');
  if (!fs.existsSync(bundle))
    throw new Error(`task ${task.id} 的起始仓库 bundle 不存在：${bundle}`);
  await cmd('git', ['clone', '--bare', bundle, seed]);
  await cmd('git', ['-C', seed, 'cat-file', '-e', `${task.repo.commit}^{commit}`]);
  // 没有 workflow 的起始仓库永远等不到 push 的 CI
  await cmd('git', ['-C', seed, 'cat-file', '-e', `${task.repo.commit}:.github/workflows`]);

  await cmd('gh', [
    'repo',
    'create',
    repo,
    '--private',
    '--description',
    `wf-dashboard eval run ${runId} (${task.id})`,
  ]);
  await cmd('git', [
    '-C',
    seed,
    'push',
    `https://github.com/${repo}.git`,
    `${task.repo.commit}:refs/heads/main`,
  ]);
  const view = await waitDefaultBranchMain(repo);
  const mainSha = await branchSha(repo, 'main');
  if (mainSha !== task.repo.commit) {
    throw new Error(`${repo} main 在 ${mainSha}，应为 ${task.repo.commit}`);
  }

  const failed = (await waitRuns(repo, mainSha)).filter((r) => r.conclusion !== 'success');
  if (failed.length > 0) {
    throw new Error(`${repo} 起始代码的 CI 未通过：${failed.map((r) => r.url).join(', ')}`);
  }
  await ghJson(
    ['api', '-X', 'POST', `repos/${repo}/rulesets`, '--input', '-'],
    z.object({ id: z.number() }).loose(),
    JSON.stringify(ciRuleset),
  );
  return { repo, url: view.url, mainSha };
}

// /lfg 运行用：只有一个初始提交，没有 CI 与 ruleset。
// 初始提交在本地建在 main 上再推送：--add-readme 会用组织的默认分支名（txehq 为 master）
export async function createEmptyRunRepo(runId: string): Promise<RunRepo> {
  const repo = runRepoName(runId);
  const seed = path.join(config.runsDir, runId, 'seed');
  fs.mkdirSync(seed, { recursive: true });
  fs.writeFileSync(path.join(seed, 'README.md'), `# wfe-${runId}\n`);
  await cmd('git', ['init', '-b', 'main'], { cwd: seed });
  await cmd('git', ['add', 'README.md'], { cwd: seed });
  // 本机 git 可能没有配置身份；初始提交以 dashboard 的名义创建
  await cmd(
    'git',
    [
      '-c',
      'user.name=wf-dashboard',
      '-c',
      'user.email=wf-dashboard@users.noreply.github.com',
      'commit',
      '-m',
      'chore: initial commit',
    ],
    { cwd: seed },
  );
  await cmd('gh', [
    'repo',
    'create',
    repo,
    '--private',
    '--description',
    `wf-dashboard eval run ${runId}`,
  ]);
  await cmd('git', ['push', `https://github.com/${repo}.git`, 'main:refs/heads/main'], {
    cwd: seed,
  });
  const view = await waitDefaultBranchMain(repo);
  return { repo, url: view.url, mainSha: await branchSha(repo, 'main') };
}

const CheckBucket = z.enum(['pass', 'fail', 'pending', 'skipping', 'cancel']);
const PrCheck = z.object({ name: z.string(), bucket: CheckBucket, state: z.string() });
export type PrCheck = z.infer<typeof PrCheck>;

export async function prChecks(repo: string, pr: number): Promise<PrCheck[]> {
  const result = await execa(
    'gh',
    ['pr', 'checks', String(pr), '--repo', repo, '--json', 'name,bucket,state'],
    { reject: false },
  );
  // 有 check 未通过时退出码为 1（fail）或 8（pending），JSON 照常输出
  if (result.stdout.trim() !== '' && [0, 1, 8].includes(result.exitCode ?? -1)) {
    return z.array(PrCheck).parse(JSON.parse(result.stdout));
  }
  // head 上还没有任何 check（例如刚推送、workflow 尚未注册）
  if (result.exitCode === 1 && result.stderr.includes('no checks reported')) return [];
  throw new Error(
    `gh pr checks ${repo}#${String(pr)} 退出码 ${String(result.exitCode)}：${result.stderr}`,
  );
}

const PrListItem = z.object({
  number: z.number(),
  url: z.string(),
  isDraft: z.boolean(),
  headRefOid: z.string(),
  state: z.string(),
  createdAt: z.string(),
});

export interface PrInfo {
  number: number;
  url: string;
  isDraft: boolean;
  head: string;
  state: string;
  checks: PrCheck[];
}

// 运行仓库中最新建的 PR；还没有 PR 时为 null
export async function readPr(repo: string): Promise<PrInfo | null> {
  const prs = await ghJson(
    [
      'pr',
      'list',
      '--repo',
      repo,
      '--state',
      'all',
      '--limit',
      '100',
      '--json',
      'number,url,isDraft,headRefOid,state,createdAt',
    ],
    z.array(PrListItem),
  );
  const latest = prs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (latest === undefined) return null;
  return {
    number: latest.number,
    url: latest.url,
    isDraft: latest.isDraft,
    head: latest.headRefOid,
    state: latest.state,
    checks: await prChecks(repo, latest.number),
  };
}

const Rule = z.object({ type: z.string() }).loose();
const RequiredChecksRule = z
  .object({
    parameters: z
      .object({ required_status_checks: z.array(z.object({ context: z.string() }).loose()) })
      .loose(),
  })
  .loose();

export async function requiredContexts(repo: string, branch: string): Promise<string[]> {
  const rules = await ghJson(['api', `repos/${repo}/rules/branches/${branch}`], z.array(Rule));
  return rules
    .filter((r) => r.type === 'required_status_checks')
    .flatMap((r) =>
      RequiredChecksRule.parse(r).parameters.required_status_checks.map((c) => c.context),
    );
}

export interface IcEndpoint {
  reached: boolean;
  ciGreen: boolean;
  isDraft: boolean;
  head: string;
  missingRequired: string[];
}

// 终点：PR 已离开 draft，当前 head 上 check 非空且全部 pass，required contexts 全部在通过的 check 中
export async function icEndpoint(repo: string, pr: number): Promise<IcEndpoint> {
  const view = await ghJson(
    ['pr', 'view', String(pr), '--repo', repo, '--json', 'isDraft,headRefOid,baseRefName'],
    z.object({ isDraft: z.boolean(), headRefOid: z.string(), baseRefName: z.string() }),
  );
  const checks = await prChecks(repo, pr);
  const required = await requiredContexts(repo, view.baseRefName);
  const passed = new Set(checks.filter((c) => c.bucket === 'pass').map((c) => c.name));
  const missingRequired = required.filter((name) => !passed.has(name));
  const ciGreen =
    checks.length > 0 && checks.every((c) => c.bucket === 'pass') && missingRequired.length === 0;
  return {
    reached: !view.isDraft && ciGreen,
    ciGreen,
    isDraft: view.isDraft,
    head: view.headRefOid,
    missingRequired,
  };
}

// 隐藏测试用：把 PR 分支浅克隆到 dest（data/runs/<runId>/grading/checkout）
export async function clonePrBranch(
  repo: string,
  branch: string,
  dest: string,
): Promise<{ head: string }> {
  await cmd('gh', ['repo', 'clone', repo, dest, '--', '--branch', branch, '--depth', '1']);
  return { head: (await cmd('git', ['-C', dest, 'rev-parse', 'HEAD'])).trim() };
}
