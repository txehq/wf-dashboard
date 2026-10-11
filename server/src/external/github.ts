import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { execa } from 'execa';
import { z } from 'zod';
import { config } from '../config.js';
import type { LinkedPr } from '../tasks/import-schema.js';
import type { IcTask } from '../tasks/schema.js';
import {
  analyzeWorkflows,
  isWorkflowPath,
  type RemoteWorkflowRef,
  type WorkflowFile,
} from '../tasks/workflow-checks.js';

export const ORG = 'txehq';
// GitHub Actions app：只有 Actions 报告的 check 才满足 required check，同名 commit status 无法冒充
const ACTIONS_INTEGRATION_ID = 15368;
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

// 空仓库的 defaultBranchRef 为空；第一次推送后要过几秒才变成 main。signal 中止（服务关闭）时停止等待
async function waitDefaultBranchMain(repo: string, signal: AbortSignal) {
  const deadline = Date.now() + DEFAULT_BRANCH_TIMEOUT_MS;
  for (;;) {
    signal.throwIfAborted();
    const view = await repoView(repo);
    if (view.defaultBranchRef.name === 'main') return view;
    if (view.defaultBranchRef.name !== '' || Date.now() > deadline) {
      throw new Error(`${repo} 的默认分支是 "${view.defaultBranchRef.name}"，应为 main`);
    }
    await sleep(1_000, undefined, { signal });
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

// 推送后几秒内列表可能为空，要等到"非空且全部 completed"；signal 中止时停止等待
export async function waitRuns(
  repo: string,
  sha: string,
  signal: AbortSignal,
): Promise<WorkflowRun[]> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  for (;;) {
    signal.throwIfAborted();
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
    await sleep(RUN_POLL_MS, undefined, { signal });
  }
}

// ruleset 的 required checks 只认 GitHub Actions 报告的 check：同名 commit status 无法冒充
function ciRuleset(requiredChecks: string[]) {
  return {
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
          required_status_checks: requiredChecks.map((context) => ({
            context,
            integration_id: ACTIONS_INTEGRATION_ID,
          })),
        },
      },
    ],
  };
}

const CheckRun = z
  .object({
    name: z.string(),
    status: z.string(),
    conclusion: z.string().nullable(),
    html_url: z.string(),
    app: z.object({ id: z.number() }).loose().nullable(),
  })
  .loose();

// GitHub 的 required check 接受的结论
const PASSING_CONCLUSIONS = ['success', 'skipped', 'neutral'];

async function actionsCheckRuns(repo: string, sha: string) {
  const pages = await ghJson(
    ['api', `repos/${repo}/commits/${sha}/check-runs?per_page=100`, '--paginate', '--slurp'],
    z.array(z.object({ check_runs: z.array(CheckRun) }).loose()),
  );
  return pages.flatMap((p) => p.check_runs).filter((c) => c.app?.id === ACTIONS_INTEGRATION_ID);
}

// 推送起始代码后，由 push 触发的 required check 必须全部结束且通过；signal 中止时停止等待
async function waitPushChecks(repo: string, sha: string, names: string[], signal: AbortSignal) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  for (;;) {
    signal.throwIfAborted();
    const runs = await actionsCheckRuns(repo, sha);
    const found = names.map((name) => ({ name, run: runs.find((r) => r.name === name) }));
    const pending = found.filter((f) => f.run?.status !== 'completed').map((f) => f.name);
    if (pending.length === 0) {
      const failed = found.filter((f) => !PASSING_CONCLUSIONS.includes(f.run?.conclusion ?? ''));
      if (failed.length > 0) {
        throw new Error(
          `${repo} 起始代码的 required check 未通过：${failed.map((f) => `${f.name} ${f.run?.conclusion ?? ''} ${f.run?.html_url ?? ''}`).join(', ')}`,
        );
      }
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${repo}@${sha} 的 check ${pending.join('、')} ${String(RUN_TIMEOUT_MS)}ms 内未结束`,
      );
    }
    await sleep(RUN_POLL_MS, undefined, { signal });
  }
}

// bare 仓库中某个 commit 的 workflow 文件；没有 .github/workflows 时为空
export async function seedWorkflowFiles(seed: string, commit: string): Promise<WorkflowFile[]> {
  const tree = await execa('git', ['-C', seed, 'cat-file', '-t', `${commit}:.github/workflows`], {
    reject: false,
  });
  if (tree.exitCode !== 0) {
    await cmd('git', ['-C', seed, 'cat-file', '-e', `${commit}^{commit}`]);
    return [];
  }
  const names = await cmd('git', [
    '-C',
    seed,
    'ls-tree',
    '--name-only',
    `${commit}:.github/workflows`,
  ]);
  const paths = names
    .split('\n')
    .filter((name) => name !== '')
    .map((name) => `.github/workflows/${name}`)
    .filter(isWorkflowPath);
  return Promise.all(
    paths.map(async (p) => ({
      path: p,
      content: await cmd('git', ['-C', seed, 'show', `${commit}:${p}`]),
    })),
  );
}

// /ic 运行的仓库副本。顺序不能调换：ruleset 生效后直接推送 main 会被拒绝（GH013），
// 所以先推送起始代码、等由 push 触发的 required check 结束，最后以 task 的 requiredChecks 建 ruleset（为空时不建），
// agent 只能经 PR 改代码
export async function createRunRepo(
  task: IcTask,
  runId: string,
  signal: AbortSignal,
): Promise<RunRepo> {
  const repo = runRepoName(runId);
  const bundle = path.join(task.dir, task.repo.path);
  const seed = path.join(config.runsDir, runId, 'seed.git');
  if (!fs.existsSync(bundle))
    throw new Error(`task ${task.id} 的起始仓库 bundle 不存在：${bundle}`);
  await cmd('git', ['clone', '--bare', bundle, seed]);
  await cmd('git', ['-C', seed, 'cat-file', '-e', `${task.repo.commit}^{commit}`]);
  // 推送后要等待的只有由 push 触发的 required check
  const analysis = await analyzeWorkflows(
    await seedWorkflowFiles(seed, task.repo.commit),
    readRemoteWorkflow,
  );
  const pushChecks = task.requiredChecks.filter((name) =>
    analysis.jobs.some((j) => j.checkName === name && j.onPush),
  );

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
  // 推送之后本地副本不再需要
  fs.rmSync(seed, { recursive: true });
  const view = await waitDefaultBranchMain(repo, signal);
  const mainSha = await branchSha(repo, 'main');
  if (mainSha !== task.repo.commit) {
    throw new Error(`${repo} main 在 ${mainSha}，应为 ${task.repo.commit}`);
  }

  if (pushChecks.length > 0) await waitPushChecks(repo, mainSha, pushChecks, signal);
  if (task.requiredChecks.length > 0) {
    await ghJson(
      ['api', '-X', 'POST', `repos/${repo}/rulesets`, '--input', '-'],
      z.object({ id: z.number() }).loose(),
      JSON.stringify(ciRuleset(task.requiredChecks)),
    );
  }
  return { repo, url: view.url, mainSha };
}

// /lfg 运行用：只有一个初始提交，没有 CI 与 ruleset。
// 初始提交在本地建在 main 上再推送：--add-readme 会用组织的默认分支名（txehq 为 master）
export async function createEmptyRunRepo(runId: string, signal: AbortSignal): Promise<RunRepo> {
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
  fs.rmSync(seed, { recursive: true });
  const view = await waitDefaultBranchMain(repo, signal);
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
  if (result.exitCode === undefined) {
    throw new Error(`gh pr checks ${repo}#${String(pr)} 被信号 ${String(result.signal)} 结束`);
  }
  // 有 check 未通过时退出码为 1（fail）或 8（pending），JSON 照常输出
  if (result.stdout.trim() !== '' && [0, 1, 8].includes(result.exitCode)) {
    return z.array(PrCheck).parse(JSON.parse(result.stdout));
  }
  // head 上还没有任何 check（例如刚推送、workflow 尚未注册）：gh 只用这句 stderr 区分它与其他退出码 1 的错误
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

// 终点（Contracts 第 13 节）：PR 仍处于 OPEN 并已离开 draft，task 的 requiredChecks 在当前 head 上全部通过
// （结论为 success、skipped 或 neutral，与 GitHub 的 required check 相同）；requiredChecks 为空时只要求 PR 不是 draft。
// 其他 check（例如副本中没有 runner、永远排队的 job）不影响终点。/ic 的终点是一个等待人审阅的 PR：已关闭或已合并的 PR 不算
export async function icEndpoint(
  repo: string,
  pr: number,
  requiredChecks: string[],
): Promise<IcEndpoint> {
  const view = await ghJson(
    ['pr', 'view', String(pr), '--repo', repo, '--json', 'isDraft,headRefOid,state'],
    z.object({ isDraft: z.boolean(), headRefOid: z.string(), state: z.string() }),
  );
  const checks = await prChecks(repo, pr);
  const passed = new Set(
    checks.filter((c) => c.bucket === 'pass' || c.bucket === 'skipping').map((c) => c.name),
  );
  const missingRequired = requiredChecks.filter((name) => !passed.has(name));
  const ciGreen = missingRequired.length === 0;
  return {
    reached: view.state === 'OPEN' && !view.isDraft && ciGreen,
    ciGreen,
    isDraft: view.isDraft,
    head: view.headRefOid,
    missingRequired,
  };
}

// PR 的 head 分支名，记在评分明细中
export async function prBranch(repo: string, pr: number): Promise<string> {
  return (
    await ghJson(
      ['pr', 'view', String(pr), '--repo', repo, '--json', 'headRefName'],
      z.object({ headRefName: z.string().min(1) }),
    )
  ).headRefName;
}

// 隐藏测试用：把 PR 的 head 浅克隆到 dest（data/runs/<runId>/grading/checkout）。按 refs/pull/<n>/head 取，
// PR 已合并、分支已删除时同样可以取到
export async function clonePr(repo: string, pr: number, dest: string): Promise<{ head: string }> {
  await cmd('gh', ['repo', 'clone', repo, dest, '--', '--depth', '1']);
  await cmd('git', ['-C', dest, 'fetch', '--depth', '1', 'origin', `pull/${String(pr)}/head`]);
  await cmd('git', ['-C', dest, 'checkout', '--quiet', '--detach', 'FETCH_HEAD']);
  return { head: (await cmd('git', ['-C', dest, 'rev-parse', 'HEAD'])).trim() };
}

// 验收标准 judge 的输入：PR 的完整 diff、标题与正文
export async function prDiff(repo: string, pr: number): Promise<string> {
  return cmd('gh', ['pr', 'diff', String(pr), '--repo', repo]);
}

export async function prDescription(repo: string, pr: number) {
  return ghJson(
    ['pr', 'view', String(pr), '--repo', repo, '--json', 'title,body,headRefOid'],
    z.object({ title: z.string(), body: z.string(), headRefOid: z.string() }),
  );
}

// 以下供从 Linear 导入 ic task（Contracts 第 13 节）：只读取源仓库，不向它写任何东西

const PR_URL =
  /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)(?:[/?#].*)?$/;

// Linear 附件中的 GitHub PR 链接；其他链接为 null
export function parsePrUrl(url: string): { repo: string; number: number } | null {
  const m = PR_URL.exec(url);
  if (m?.[1] === undefined || m[2] === undefined) return null;
  return { repo: m[1], number: Number(m[2]) };
}

const PrView = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  state: z.string(),
  mergedAt: z.string().nullable(),
  baseRefOid: z.string(),
});

// 仓库改名（capsohq → txehq）后旧链接经 GitHub 跳转，仓库名取 PR 的规范 URL
export async function readLinkedPr(repo: string, pr: number): Promise<LinkedPr> {
  const view = await ghJson(
    [
      'pr',
      'view',
      String(pr),
      '--repo',
      repo,
      '--json',
      'number,url,title,state,mergedAt,baseRefOid',
    ],
    PrView,
  );
  const canonical = parsePrUrl(view.url);
  if (canonical === null) throw new Error(`gh 返回的 PR URL 不是 GitHub PR：${view.url}`);
  const merged = view.state === 'MERGED';
  return {
    repo: canonical.repo,
    number: view.number,
    url: view.url,
    title: view.title,
    state: view.state,
    mergedAt: merged ? view.mergedAt : null,
    // 合并时 GitHub 把 base 更新为合并前 base 分支的 head，即这个改动的起点
    baseCommit: merged ? view.baseRefOid : null,
  };
}

const CommitView = z.object({
  sha: z.string(),
  commit: z
    .object({
      message: z.string(),
      committer: z.object({ date: z.string() }).loose(),
    })
    .loose(),
});

// ref 为 commit sha 或分支名
export async function readCommit(repo: string, ref: string) {
  const view = await ghJson(['api', `repos/${repo}/commits/${ref}`], CommitView);
  return {
    sha: view.sha,
    title: view.commit.message.split('\n')[0] ?? '',
    date: view.commit.committer.date,
  };
}

export async function defaultBranch(repo: string): Promise<string> {
  const view = await repoView(repo);
  if (view.defaultBranchRef.name === '') throw new Error(`${repo} 没有默认分支（空仓库）`);
  return view.defaultBranchRef.name;
}

const Tree = z.object({
  truncated: z.boolean(),
  tree: z.array(z.object({ path: z.string(), type: z.string(), sha: z.string() }).loose()),
});
const Blob = z.object({ content: z.string(), encoding: z.literal('base64') });

async function treeEntries(repo: string, sha: string) {
  const tree = await ghJson(['api', `repos/${repo}/git/trees/${sha}`], Tree);
  if (tree.truncated) throw new Error(`${repo} 的 tree ${sha} 被 GitHub 截断`);
  return tree.tree;
}

const decodeBase64 = (content: string) => Buffer.from(content, 'base64').toString('utf8');

// commit 中 .github/workflows/ 下的 workflow 文件；没有这个目录时为空
export async function readWorkflowFiles(repo: string, commit: string): Promise<WorkflowFile[]> {
  let entries = await treeEntries(repo, commit);
  for (const dir of ['.github', 'workflows']) {
    const entry = entries.find((e) => e.path === dir && e.type === 'tree');
    if (entry === undefined) return [];
    entries = await treeEntries(repo, entry.sha);
  }
  const files = entries
    .filter((e) => e.type === 'blob')
    .map((e) => ({ path: `.github/workflows/${e.path}`, sha: e.sha }))
    .filter((f) => isWorkflowPath(f.path));
  return Promise.all(
    files.map(async (f) => ({
      path: f.path,
      content: decodeBase64(
        (await ghJson(['api', `repos/${repo}/git/blobs/${f.sha}`], Blob)).content,
      ),
    })),
  );
}

// 其他仓库的 reusable workflow（uses: owner/repo/.github/workflows/x.yml@ref）
export async function readRemoteWorkflow(ref: RemoteWorkflowRef): Promise<string> {
  const file = await ghJson(
    [
      'api',
      `repos/${ref.owner}/${ref.repository}/contents/${ref.path}?ref=${encodeURIComponent(ref.version)}`,
    ],
    Blob,
  );
  return decodeBase64(file.content);
}

// 在 commit 处生成起始仓库的 bundle：完整克隆源仓库（bare），main 指向 commit 后打包 main 的全部历史。
// 先写临时文件，校验后再改名
export async function createRepoBundle(repo: string, commit: string, bundlePath: string) {
  const work = path.join(
    config.dataDir,
    'task-imports',
    `${repo.replace('/', '__')}-${commit.slice(0, 12)}-${String(process.pid)}-${String(Date.now())}`,
  );
  fs.mkdirSync(path.dirname(work), { recursive: true });
  await cmd('gh', ['repo', 'clone', repo, work, '--', '--bare', '--quiet']);
  // 不在任何分支上的 commit（例如只在 PR 的 ref 中）需要单独取
  const present = await execa('git', ['-C', work, 'cat-file', '-e', `${commit}^{commit}`], {
    reject: false,
  });
  if (present.exitCode !== 0) await cmd('git', ['-C', work, 'fetch', '--quiet', 'origin', commit]);
  await cmd('git', ['-C', work, 'update-ref', 'refs/heads/main', commit]);
  const tmp = `${bundlePath}.${String(process.pid)}.tmp`;
  fs.mkdirSync(path.dirname(bundlePath), { recursive: true });
  await cmd('git', ['-C', work, 'bundle', 'create', '--quiet', tmp, 'main']);
  await cmd('git', ['-C', work, 'bundle', 'verify', '--quiet', tmp]);
  fs.renameSync(tmp, bundlePath);
  fs.rmSync(work, { recursive: true });
}

// bundle 中 main 指向的 commit
export async function bundleHead(bundlePath: string): Promise<string> {
  const heads = await cmd('git', ['bundle', 'list-heads', bundlePath, 'refs/heads/main'], {
    cwd: path.dirname(bundlePath),
  });
  const sha = heads.split(' ')[0];
  if (sha === undefined || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`${bundlePath} 中没有 refs/heads/main：${heads}`);
  }
  return sha;
}
