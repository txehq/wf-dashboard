import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { execa } from 'execa';
import { z } from 'zod';
import { config } from '../config.js';
import type { LinkedPr } from '../tasks/import-schema.js';
import { copyCommitBody, copyWorkflows } from '../tasks/copy-workflows.js';
import type { IcTask } from '../tasks/schema.js';
import {
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
export function ciRuleset(requiredChecks: string[]) {
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

// 本地仓库中某个 commit 的 workflow 文件；没有 .github/workflows 时为空
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

// 推送前的本地 clone：data/runs/<runId>/seed，推送之后删除
export const seedDir = (runId: string) => path.join(config.runsDir, runId, 'seed');

// 建仓库的 gh 参数：ic 的副本带 task id，lfg（task 为 null）只有 run id。导入的 task 的 id 由来源工单编号得出，
// 副本中不出现来源
export function repoCreateArgs(task: IcTask | null, runId: string): string[] {
  const description =
    task === null || task.source !== undefined
      ? `wf-dashboard eval run ${runId}`
      : `wf-dashboard eval run ${runId} (${task.id})`;
  return ['repo', 'create', runRepoName(runId), '--private', '--description', description];
}

// /ic 运行的仓库副本的内容（Contracts 第 13 节），写在 seed 中，返回要推送的 HEAD。在起始 commit 之上加一个
// wf-dashboard 提交的 commit：workflow 的 on 只保留 pull_request 与 workflow_call，两者都没有的文件删除；没有要改的文件时不加
export async function prepareCopySeed(task: IcTask, seed: string): Promise<string> {
  const bundle = path.join(task.dir, task.repo.path);
  if (!fs.existsSync(bundle))
    throw new Error(`task ${task.id} 的起始仓库 bundle 不存在：${bundle}`);
  await cmd('git', ['clone', '--quiet', '--no-checkout', bundle, seed]);
  await cmd('git', ['-C', seed, 'checkout', '--quiet', '--detach', task.repo.commit]);
  const files = (await seedWorkflowFiles(seed, task.repo.commit)).map((f) => ({
    ...f,
    content: fs.readFileSync(path.join(seed, f.path), 'utf8'),
  }));
  const changes = copyWorkflows(files);
  for (const change of changes) {
    const file = path.join(seed, change.path);
    if (change.kind === 'deleted') fs.rmSync(file);
    else fs.writeFileSync(file, change.content);
  }
  if (changes.length > 0) {
    await cmd('git', ['-C', seed, 'add', '--all', '.github/workflows']);
    // 本机 git 可能没有配置身份；这个 commit 以 dashboard 的名义创建
    await cmd('git', [
      '-C',
      seed,
      '-c',
      'user.name=wf-dashboard',
      '-c',
      'user.email=wf-dashboard@users.noreply.github.com',
      'commit',
      '--quiet',
      '-m',
      COPY_COMMIT_TITLE,
      '-m',
      copyCommitBody(changes),
    ]);
  }
  return (await cmd('git', ['-C', seed, 'rev-parse', 'HEAD'])).trim();
}

// /lfg 运行的仓库内容：只有一个初始提交，没有 CI。初始提交在本地建在 main 上再推送
// （gh repo create --add-readme 会用组织的默认分支名，txehq 为 master）
export async function prepareEmptySeed(runId: string, seed: string): Promise<string> {
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
  return (await cmd('git', ['-C', seed, 'rev-parse', 'HEAD'])).trim();
}

// 把 seed 的 HEAD 推送为 remote 的 main；remote 为 GitHub 地址或本地 bare 仓库的路径
export async function pushSeed(seed: string, remote: string): Promise<void> {
  await cmd('git', ['-C', seed, 'push', '--quiet', remote, 'HEAD:refs/heads/main']);
}

// 推送后 GitHub 中没有可以由 push、定时或手动触发的 workflow，不等待默认分支上的 CI。顺序不能调换：ruleset 生效后
// 直接推送 main 会被拒绝（GH013），所以先推送、最后以 task 的 requiredChecks 建 ruleset（为空时不建），agent 只能经 PR 改代码
export async function createRunRepo(
  task: IcTask,
  runId: string,
  signal: AbortSignal,
): Promise<RunRepo> {
  const repo = runRepoName(runId);
  const seed = seedDir(runId);
  const head = await prepareCopySeed(task, seed);
  await cmd('gh', repoCreateArgs(task, runId));
  await pushSeed(seed, `https://github.com/${repo}.git`);
  // 推送之后本地副本不再需要
  fs.rmSync(seed, { recursive: true });
  const view = await waitDefaultBranchMain(repo, signal);
  const mainSha = await branchSha(repo, 'main');
  if (mainSha !== head) throw new Error(`${repo} main 在 ${mainSha}，应为 ${head}`);

  if (task.requiredChecks.length > 0) {
    await ghJson(
      ['api', '-X', 'POST', `repos/${repo}/rulesets`, '--input', '-'],
      z.object({ id: z.number() }).loose(),
      JSON.stringify(ciRuleset(task.requiredChecks)),
    );
  }
  return { repo, url: view.url, mainSha };
}

export const COPY_COMMIT_TITLE = 'eval copy: keep only pull_request workflows';

// /lfg 运行用：只有一个初始提交，没有 CI 与 ruleset
export async function createEmptyRunRepo(runId: string, signal: AbortSignal): Promise<RunRepo> {
  const repo = runRepoName(runId);
  const seed = seedDir(runId);
  await prepareEmptySeed(runId, seed);
  await cmd('gh', repoCreateArgs(null, runId));
  await pushSeed(seed, `https://github.com/${repo}.git`);
  fs.rmSync(seed, { recursive: true });
  const view = await waitDefaultBranchMain(repo, signal);
  return { repo, url: view.url, mainSha: await branchSha(repo, 'main') };
}

const CheckBucket = z.enum(['pass', 'fail', 'pending', 'skipping', 'cancel']);
const PrCheck = z.object({ name: z.string(), bucket: CheckBucket, state: z.string() });
export type PrCheck = z.infer<typeof PrCheck>;

// 读取 PR 的 gh 命令与它们输出的解析分开：解析函数也用于测试中录下的真实输出（test/fixtures/gh/，
// 由 scripts/record-gh-fixtures.ts 录制）
export const prArgs = {
  list: (repo: string) => [
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
  checks: (repo: string, pr: number) => [
    'pr',
    'checks',
    String(pr),
    '--repo',
    repo,
    '--json',
    'name,bucket,state',
  ],
  endpoint: (repo: string, pr: number) => [
    'pr',
    'view',
    String(pr),
    '--repo',
    repo,
    '--json',
    'isDraft,headRefOid,state',
  ],
  branch: (repo: string, pr: number) => [
    'pr',
    'view',
    String(pr),
    '--repo',
    repo,
    '--json',
    'headRefName',
  ],
  description: (repo: string, pr: number) => [
    'pr',
    'view',
    String(pr),
    '--repo',
    repo,
    '--json',
    'title,body,headRefOid',
  ],
  diff: (repo: string, pr: number) => ['pr', 'diff', String(pr), '--repo', repo],
  snapshot: (repo: string, pr: number) => [
    'pr',
    'view',
    String(pr),
    '--repo',
    repo,
    '--json',
    'number,url,title,body,state,isDraft,headRefOid,reviews,comments',
  ],
  reviewThreads: (repo: string, pr: number) => {
    const [owner, name] = repo.split('/');
    if (owner === undefined || name === undefined)
      throw new Error(`仓库名不是 owner/name：${repo}`);
    return [
      'api',
      'graphql',
      '-f',
      `query=${REVIEW_THREADS_QUERY}`,
      '-f',
      `owner=${owner}`,
      '-f',
      `name=${name}`,
      '-F',
      `number=${String(pr)}`,
    ];
  },
};

// gh 的一次调用结果；退出码非零时由解析函数决定是否是错误
export interface GhResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function ghResult(args: string[]): Promise<GhResult> {
  const result = await execa('gh', args, { reject: false });
  if (result.exitCode === undefined) {
    throw new Error(`gh ${args.join(' ')} 被信号 ${String(result.signal)} 结束`);
  }
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}

export function checksFrom(repo: string, pr: number, result: GhResult): PrCheck[] {
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

export async function prChecks(repo: string, pr: number): Promise<PrCheck[]> {
  return checksFrom(repo, pr, await ghResult(prArgs.checks(repo, pr)));
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

// gh pr list 的输出中最新建的 PR；还没有 PR 时为 null
export function latestPrFrom(stdout: string): z.infer<typeof PrListItem> | null {
  const prs = z.array(PrListItem).parse(JSON.parse(stdout));
  return prs.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

export function prInfoFrom(latest: z.infer<typeof PrListItem>, checks: PrCheck[]): PrInfo {
  return {
    number: latest.number,
    url: latest.url,
    isDraft: latest.isDraft,
    head: latest.headRefOid,
    state: latest.state,
    checks,
  };
}

// 运行仓库中最新建的 PR；还没有 PR 时为 null
export async function readPr(repo: string): Promise<PrInfo | null> {
  const latest = latestPrFrom(await cmd('gh', prArgs.list(repo)));
  if (latest === null) return null;
  return prInfoFrom(latest, await prChecks(repo, latest.number));
}

// PR 的 review、评论与 checks 只在 GitHub 上；run 进入 grading 时存一份快照（Contracts 15.2），仓库被删除后分析仍能读到
const Author = z.object({ login: z.string() }).nullable();
const login = (a: z.infer<typeof Author>) => a?.login ?? null;

const SnapshotView = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  body: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  headRefOid: z.string(),
  reviews: z.array(
    z.object({ author: Author, state: z.string(), body: z.string(), submittedAt: z.string() }),
  ),
  comments: z.array(z.object({ author: Author, body: z.string(), createdAt: z.string() })),
});

const ThreadComment = z.object({
  author: Author,
  body: z.string(),
  createdAt: z.string(),
  url: z.string(),
});
const PageInfo = z.object({ hasNextPage: z.boolean() });
const ReviewThreads = z.object({
  data: z.object({
    repository: z.object({
      pullRequest: z.object({
        reviewThreads: z.object({
          pageInfo: PageInfo,
          nodes: z.array(
            z.object({
              path: z.string(),
              line: z.number().nullable(),
              isResolved: z.boolean(),
              isOutdated: z.boolean(),
              comments: z.object({ pageInfo: PageInfo, nodes: z.array(ThreadComment) }),
            }),
          ),
        }),
      }),
    }),
  }),
});

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        pageInfo { hasNextPage }
        nodes {
          path line isResolved isOutdated
          comments(first: 100) {
            pageInfo { hasNextPage }
            nodes { author { login } body createdAt url }
          }
        }
      }
    }
  }
}`;

export const PrSnapshot = z.object({
  number: z.number(),
  url: z.string(),
  title: z.string(),
  body: z.string(),
  state: z.string(),
  isDraft: z.boolean(),
  head: z.string(),
  reviews: z.array(
    z.object({
      author: z.string().nullable(),
      state: z.string(),
      body: z.string(),
      submittedAt: z.string(),
    }),
  ),
  // 行内 review 评论按 thread 分组
  reviewThreads: z.array(
    z.object({
      path: z.string(),
      line: z.number().nullable(),
      isResolved: z.boolean(),
      isOutdated: z.boolean(),
      comments: z.array(
        z.object({
          author: z.string().nullable(),
          body: z.string(),
          createdAt: z.string(),
          url: z.string(),
        }),
      ),
    }),
  ),
  // PR 对话区的评论
  comments: z.array(
    z.object({ author: z.string().nullable(), body: z.string(), createdAt: z.string() }),
  ),
  checks: z.array(PrCheck),
});
export type PrSnapshot = z.infer<typeof PrSnapshot>;

// latest 为 readPr 的结果；view 与 threads 为 prArgs.snapshot、prArgs.reviewThreads 的输出
export function snapshotFrom(
  repo: string,
  latest: PrInfo,
  viewStdout: string,
  threadsStdout: string,
): PrSnapshot {
  const view = SnapshotView.parse(JSON.parse(viewStdout));
  const threads = ReviewThreads.parse(JSON.parse(threadsStdout)).data.repository.pullRequest
    .reviewThreads;
  if (threads.pageInfo.hasNextPage || threads.nodes.some((t) => t.comments.pageInfo.hasNextPage)) {
    throw new Error(
      `${repo}#${String(latest.number)} 的 review thread 或评论超过 100 条，快照不完整`,
    );
  }
  return {
    number: view.number,
    url: view.url,
    title: view.title,
    body: view.body,
    state: view.state,
    isDraft: view.isDraft,
    head: view.headRefOid,
    reviews: view.reviews.map((r) => ({ ...r, author: login(r.author) })),
    reviewThreads: threads.nodes.map((t) => ({
      path: t.path,
      line: t.line,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      comments: t.comments.nodes.map((c) => ({ ...c, author: login(c.author) })),
    })),
    comments: view.comments.map((c) => ({ ...c, author: login(c.author) })),
    checks: latest.checks,
  };
}

// 运行仓库中最新建的 PR 的快照；还没有 PR 时为 null
export async function readPrSnapshot(repo: string): Promise<PrSnapshot | null> {
  const latest = await readPr(repo);
  if (latest === null) return null;
  return snapshotFrom(
    repo,
    latest,
    await cmd('gh', prArgs.snapshot(repo, latest.number)),
    await cmd('gh', prArgs.reviewThreads(repo, latest.number)),
  );
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
// 其他 check（例如副本中没有 runner、永远排队的 job）不影响终点。/ic 的终点是一个等待人审阅的 PR：已关闭或已合并的 PR 不算。
// viewStdout 为 prArgs.endpoint 的输出
export function endpointFrom(
  viewStdout: string,
  checks: PrCheck[],
  requiredChecks: string[],
): IcEndpoint {
  const view = z
    .object({ isDraft: z.boolean(), headRefOid: z.string(), state: z.string() })
    .parse(JSON.parse(viewStdout));
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

export async function icEndpoint(
  repo: string,
  pr: number,
  requiredChecks: string[],
): Promise<IcEndpoint> {
  const view = await cmd('gh', prArgs.endpoint(repo, pr));
  return endpointFrom(view, await prChecks(repo, pr), requiredChecks);
}

export const branchFrom = (stdout: string) =>
  z.object({ headRefName: z.string().min(1) }).parse(JSON.parse(stdout)).headRefName;

// PR 的 head 分支名，记在评分明细中
export async function prBranch(repo: string, pr: number): Promise<string> {
  return branchFrom(await cmd('gh', prArgs.branch(repo, pr)));
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
  return cmd('gh', prArgs.diff(repo, pr));
}

export const descriptionFrom = (stdout: string) =>
  z
    .object({ title: z.string(), body: z.string(), headRefOid: z.string() })
    .parse(JSON.parse(stdout));

export async function prDescription(repo: string, pr: number) {
  return descriptionFrom(await cmd('gh', prArgs.description(repo, pr)));
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
  // 克隆与打包都在 bundle 同目录下的临时目录中进行，成功后把 bundle 改名到位；无论成败临时目录都删除，
  // 失败时错误照原文抛出
  const dir = path.dirname(bundlePath);
  fs.mkdirSync(dir, { recursive: true });
  const work = path.join(dir, `.bundle-tmp-${String(process.pid)}-${String(Date.now())}`);
  fs.mkdirSync(work);
  try {
    const clone = path.join(work, 'source.git');
    await cmd('gh', ['repo', 'clone', repo, clone, '--', '--bare', '--quiet']);
    // 不在任何分支上的 commit（例如只在 PR 的 ref 中）需要单独取
    const present = await execa('git', ['-C', clone, 'cat-file', '-e', `${commit}^{commit}`], {
      reject: false,
    });
    if (present.exitCode !== 0) {
      await cmd('git', ['-C', clone, 'fetch', '--quiet', 'origin', commit]);
    }
    await cmd('git', ['-C', clone, 'update-ref', 'refs/heads/main', commit]);
    const tmp = path.join(work, 'repo.bundle');
    await cmd('git', ['-C', clone, 'bundle', 'create', '--quiet', tmp, 'main']);
    await cmd('git', ['-C', clone, 'bundle', 'verify', '--quiet', tmp]);
    fs.renameSync(tmp, bundlePath);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
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
