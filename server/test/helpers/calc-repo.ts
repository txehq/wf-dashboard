import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../src/config.js';
import { git, testRunId } from './ic-fixture.js';

// 测试用的本地起始仓库：配合 `/lfg 做一个计算器` 建出的 TXE-3777。第一个 commit 只有一行 README.md
// （与 TXE-3777 的起始仓库相同）；第二个 commit 加入三个测试用的 workflow

export const CALC_TICKET = 'TXE-3777';
export const CALC_TICKET_URL =
  'https://linear.app/capso/issue/TXE-3777/eval-lfg-calculator-r-20261009-dqva52-p1-单文件页面外壳构建两个浏览器的自动测试和合并规则';

// ciOnPush：ci 另加 push 到 main 的触发（副本中应被去掉）
function workflowFiles(ciOnPush: boolean): Record<string, string> {
  return {
    'ci.yml': `# 合并前的检查
name: ci
on:
  pull_request:
${ciOnPush ? '  push:\n    branches: [main]\n' : ''}jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - run: echo "ci ok" # 只 echo
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
    // 一年一次，副本中不应存在
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
}

// 副本中 ci.yml 应有的内容：去掉 push 的两行，其余字节不变
export const CALC_CI_IN_COPY = workflowFiles(false)['ci.yml'];

export interface CalcRepo {
  readmeCommit: string;
  workflowsCommit: string;
  // 本地仓库，供生成 task 的 bundle
  local: string;
  workflows: Record<string, string>;
}

export async function createCalcStartRepo(options: { ciOnPush?: boolean } = {}): Promise<CalcRepo> {
  const workflows = workflowFiles(options.ciOnPush === true);
  const local = path.join(config.repoRoot, '.work/test-tasks', testRunId('calc'), 'source');
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
  return { readmeCommit, workflowsCommit, local, workflows };
}
