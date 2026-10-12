import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { format, resolveConfig } from 'prettier';
import { config } from '../src/config.js';
import { ghResult, latestPrFrom, prArgs } from '../src/external/github.js';

// 录下评分读取 PR 时 gh 的真实输出，存为 test/fixtures/gh/<名字>/：每条命令一个 <key>.json（args、exitCode、stdout、stderr），
// meta.json 记仓库与 PR。只读取 GitHub；with-bundle 的 PR 另把 head 的完整历史打成 pr-head.bundle，供隐藏测试 checkout。
// 运行：pnpm --filter @wf-dashboard/server record:gh-fixtures
const fixtures = path.join(config.repoRoot, 'server/test/fixtures/gh');

type Key =
  'list' | 'checks' | 'endpoint' | 'branch' | 'description' | 'diff' | 'snapshot' | 'reviewThreads';

// 写成与 pnpm lint 相同的格式（仓库的 prettier 配置）
const writeJson = async (file: string, value: unknown) => {
  const options = await resolveConfig(file);
  fs.writeFileSync(file, await format(JSON.stringify(value), { ...options, filepath: file }));
};

const sources: { name: string; repo: string; keys: Key[]; bundle: boolean }[] = [
  // W7 fixture 的 subtract PR：ready、ci 通过，有对话区评论、review 与文件评论（W31 快照测试留下）
  {
    name: 'grade-pr',
    repo: 'txehq/wfe-test-grade-pr-20261012014905144',
    keys: ['list', 'checks', 'endpoint', 'branch', 'snapshot', 'reviewThreads'],
    bundle: true,
  },
  // ic-money-format 的参考实现 PR：ready、ci 通过
  {
    name: 'criteria-judge',
    repo: 'txehq/wfe-test-criteria-judge-20261011221337891',
    keys: ['list', 'checks', 'endpoint', 'branch', 'description', 'diff'],
    bundle: false,
  },
  // 两个已关闭的 PR，没有任何 check
  {
    name: 'closed-no-checks',
    repo: 'txehq/take-home-question',
    keys: ['list', 'checks', 'endpoint'],
    bundle: false,
  },
  // 没有 PR 的仓库
  { name: 'no-pr', repo: 'txehq/docker-node-awscli', keys: ['list'], bundle: false },
];

for (const source of sources) {
  const dir = path.join(fixtures, source.name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const list = await ghResult(prArgs.list(source.repo));
  if (list.exitCode !== 0) throw new Error(`gh pr list ${source.repo}：${list.stderr}`);
  const latest = latestPrFrom(list.stdout);
  const pr = latest?.number ?? null;
  await writeJson(path.join(dir, 'meta.json'), {
    repo: source.repo,
    pr,
    recordedAt: new Date().toISOString(),
  });
  for (const key of source.keys) {
    if (key !== 'list' && pr === null) throw new Error(`${source.repo} 没有 PR，不能录 ${key}`);
    const args = key === 'list' ? prArgs.list(source.repo) : prArgs[key](source.repo, pr ?? 0);
    const result = key === 'list' ? list : await ghResult(args);
    await writeJson(path.join(dir, `${key}.json`), { args, ...result });
    console.log(`${source.name}/${key}.json 退出码 ${String(result.exitCode)}`);
  }
  if (source.bundle) {
    if (latest === null) throw new Error(`${source.repo} 没有 PR，不能打包 head`);
    const work = path.join(config.repoRoot, '.work/record-gh-fixtures', source.name);
    fs.rmSync(work, { recursive: true, force: true });
    await execa('gh', ['repo', 'clone', source.repo, work, '--', '--bare', '--quiet']);
    await execa('git', ['-C', work, 'fetch', '--quiet', 'origin', `pull/${String(pr)}/head`]);
    await execa('git', ['-C', work, 'update-ref', 'refs/heads/pr', latest.headRefOid]);
    const bundle = path.join(dir, 'pr-head.bundle');
    await execa('git', ['-C', work, 'bundle', 'create', '--quiet', bundle, 'pr']);
    fs.rmSync(work, { recursive: true });
    console.log(`${source.name}/pr-head.bundle ${latest.headRefOid}`);
  }
}
