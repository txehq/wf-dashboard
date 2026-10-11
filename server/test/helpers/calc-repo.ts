import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { config } from '../../src/config.js';
import { git, testRunId } from './ic-fixture.js';

// 测试用的起始仓库（W29 起所有需要真实工单与仓库的测试都用它）：配合 `/lfg 做一个计算器` 建出的 TXE-3777，
// 测试新建 txehq/wfe-test-calc-<时间戳>。第一个 commit 只有一行 README.md（与 TXE-3777 的起始仓库相同）；
// 第二个 commit 加入三个测试用的 workflow。测试不删除这个仓库，由用户清理

export const CALC_TICKET = 'TXE-3777';
export const CALC_TICKET_URL =
  'https://linear.app/capso/issue/TXE-3777/eval-lfg-calculator-r-20261009-dqva52-p1-单文件页面外壳构建两个浏览器的自动测试和合并规则';

const workflows: Record<string, string> = {
  'ci.yml': `name: ci
on:
  pull_request:
jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - run: echo "ci ok"
`,
  'self-hosted-echo.yml': `name: self-hosted-echo
on:
  pull_request:
jobs:
  self-hosted-echo:
    runs-on: arc-linux-dind
    steps:
      - run: echo "self-hosted runner ok"
`,
  // 一年一次，副本中不应运行
  'scheduled-echo.yml': `name: scheduled-echo
on:
  schedule:
    - cron: '17 3 1 1 *'
  workflow_dispatch:
jobs:
  scheduled-echo:
    runs-on: ubuntu-latest
    steps:
      - run: echo "scheduled run"
`,
};

export interface CalcRepo {
  repo: string;
  readmeCommit: string;
  workflowsCommit: string;
  // 本地仓库，供生成 task 的 bundle
  local: string;
}

export async function createCalcStartRepo(): Promise<CalcRepo> {
  const repo = `txehq/wfe-test-calc-${testRunId('x').slice(2)}`;
  const local = path.join(config.repoRoot, '.work/test-tasks', repo.replace('/', '__'), 'source');
  fs.rmSync(local, { recursive: true, force: true });
  fs.mkdirSync(local, { recursive: true });
  await git(local, ['init', '-q', '-b', 'main']);
  fs.writeFileSync(path.join(local, 'README.md'), '# 初中机房离线网页计算器\n');
  await git(local, ['add', '-A']);
  await git(local, ['commit', '-q', '-m', 'chore: initial commit']);
  const readmeCommit = (await git(local, ['rev-parse', 'HEAD'])).stdout.trim();
  fs.mkdirSync(path.join(local, '.github/workflows'), { recursive: true });
  for (const [name, content] of Object.entries(workflows)) {
    fs.writeFileSync(path.join(local, '.github/workflows', name), content);
  }
  await git(local, ['add', '-A']);
  await git(local, ['commit', '-q', '-m', 'ci: test workflows']);
  const workflowsCommit = (await git(local, ['rev-parse', 'HEAD'])).stdout.trim();
  await execa('gh', ['repo', 'create', repo, '--private', '--description', 'W29 test start repo']);
  await git(local, ['push', '-q', `https://github.com/${repo}.git`, 'main:refs/heads/main']);
  console.log(`测试仓库 ${repo}（起始仓库，${workflowsCommit}）`);
  return { repo, readmeCommit, workflowsCommit, local };
}
