import { describe, expect, it } from 'vitest';
import { readRemoteWorkflow } from '../../src/external/github.js';
import { analyzeWorkflows, expandMatrix } from '../../src/tasks/workflow-checks.js';

describe('matrix 展开（GitHub 文档的规则）', () => {
  it('笛卡尔积、exclude、include 加进组合或成为新组合', () => {
    expect(
      expandMatrix({
        fruit: ['apple', 'pear'],
        animal: ['cat', 'dog'],
        include: [
          { color: 'green' },
          { color: 'pink', animal: 'cat' },
          { fruit: 'apple', shape: 'circle' },
          { fruit: 'banana' },
          { fruit: 'banana', animal: 'cat' },
        ],
      }),
    ).toEqual([
      { fruit: 'apple', animal: 'cat', color: 'pink', shape: 'circle' },
      { fruit: 'apple', animal: 'dog', color: 'green', shape: 'circle' },
      { fruit: 'pear', animal: 'cat', color: 'pink' },
      { fruit: 'pear', animal: 'dog', color: 'green' },
      { fruit: 'banana' },
      { fruit: 'banana', animal: 'cat' },
    ]);
    expect(
      expandMatrix({ os: ['macos-15', 'windows-latest'], v: [1, 2], exclude: [{ os: 'macos-15', v: 2 }] }),
    ).toEqual([
      { os: 'macos-15', v: 1 },
      { os: 'windows-latest', v: 1 },
      { os: 'windows-latest', v: 2 },
    ]);
    expect(expandMatrix({ include: [{ runner: 'a' }, { runner: 'b' }] })).toEqual([
      { runner: 'a' },
      { runner: 'b' },
    ]);
  });
});

describe('workflow 分析', () => {
  // 形状取自 txe-workflow 的 ci.yml：matrix 中混有组织的自托管 runner 与 GitHub 托管 runner
  const matrixCi = `
on:
  pull_request:
jobs:
  guard:
    runs-on: arc-linux-dind
    steps: [{ run: echo }]
  test:
    strategy:
      matrix:
        include:
          - runner: arc-linux-dind
            target: x86_64-unknown-linux-gnu
          - runner: macos-15
            target: aarch64-apple-darwin
    runs-on: \${{ matrix.runner }}
    steps: [{ run: echo }]
  digest:
    needs: test
    runs-on: [self-hosted, linux]
    steps: [{ run: echo }]
  grouped:
    runs-on:
      group: big-runners
    steps: [{ run: echo }]
  old:
    runs-on: ubuntu-20.04
    steps: [{ run: echo }]
`;

  it('copyRunnerLabels：arc-linux-dind 与 self-hosted 可运行；不在其中的标签、runner group、已停用的标签不可运行', async () => {
    const files = [{ path: '.github/workflows/ci.yml', content: matrixCi }];
    const withCopy = await analyzeWorkflows(files, readRemoteWorkflow, ['arc-linux-dind']);
    expect(withCopy.jobs.map((j) => [j.checkName, j.runsOn, j.status])).toEqual([
      ['guard', 'arc-linux-dind', 'required'],
      ['test (arc-linux-dind, x86_64-unknown-linux-gnu)', 'arc-linux-dind', 'required'],
      ['test (macos-15, aarch64-apple-darwin)', 'macos-15', 'required'],
      // self-hosted 加上 linux：linux 既不是托管 runner 的标签，也不在 copyRunnerLabels 中
      ['digest', 'self-hosted, linux', 'runner-unavailable'],
      ['grouped', 'group: big-runners', 'runner-unavailable'],
      ['old', 'ubuntu-20.04', 'retired'],
    ]);
    expect(withCopy.requiredChecks).toEqual([
      'guard',
      'test (arc-linux-dind, x86_64-unknown-linux-gnu)',
      'test (macos-15, aarch64-apple-darwin)',
    ]);
    const withLinux = await analyzeWorkflows(files, readRemoteWorkflow, ['arc-linux-dind', 'linux']);
    expect(withLinux.jobs.find((j) => j.checkName === 'digest')?.status).toBe('required');

    // copyRunnerLabels 为空：arc-linux-dind 的 job 不可运行，依赖它们的 job 也不运行
    const hostedOnly = await analyzeWorkflows(files, readRemoteWorkflow, []);
    expect(hostedOnly.requiredChecks).toEqual(['test (macos-15, aarch64-apple-darwin)']);
    expect(hostedOnly.jobs.find((j) => j.checkName === 'guard')?.reason).toContain(
      'copyRunnerLabels',
    );
  });

  it('needs、push 触发、paths 过滤、表达式与不合法的 workflow', async () => {
    const ci = `
on:
  pull_request:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  deploy:
    needs: build
    runs-on: [self-hosted, linux]
    steps: [{ run: echo }]
  after-deploy:
    needs: deploy
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
  dynamic:
    runs-on: \${{ inputs.runner }}
    steps: [{ run: echo }]
  named:
    name: lint-\${{ matrix.node }}
    strategy:
      matrix:
        node: [20, 22]
    runs-on: ubuntu-24.04
    steps: [{ run: echo }]
  call:
    uses: ./.github/workflows/reusable.yml
`;
    const reusable = `
on: workflow_call
jobs:
  inner:
    runs-on: windows-latest
    steps: [{ run: echo }]
`;
    const docs = `
on:
  pull_request:
    paths: ['docs/**']
jobs:
  docs:
    runs-on: ubuntu-latest
    steps: [{ run: echo }]
`;
    const broken = 'on: pull_request\njobs:\n  x:\n    steps: 3\n';
    const result = await analyzeWorkflows(
      [
        { path: '.github/workflows/ci.yml', content: ci },
        { path: '.github/workflows/reusable.yml', content: reusable },
        { path: '.github/workflows/docs.yml', content: docs },
        { path: '.github/workflows/broken.yml', content: broken },
        { path: '.github/workflows/nested/ignored.yml', content: docs },
      ],
      readRemoteWorkflow,
      ['arc-linux-dind'],
    );
    const rows = result.jobs.map((j) => [j.workflow.replace('.github/workflows/', ''), j.checkName, j.status, j.onPush]);
    expect(rows).toEqual([
      ['broken.yml', null, 'invalid', false],
      ['ci.yml', 'build', 'required', true],
      ['ci.yml', 'deploy', 'runner-unavailable', false],
      ['ci.yml', 'after-deploy', 'blocked', false],
      ['ci.yml', 'dynamic', 'unresolved', false],
      ['ci.yml', 'lint-20', 'required', true],
      ['ci.yml', 'lint-22', 'required', true],
      ['ci.yml', 'call / inner', 'required', true],
      ['docs.yml', 'docs', 'path-filtered', false],
      ['reusable.yml', 'inner', 'not-on-pr', false],
    ]);
    expect(result.jobs.find((j) => j.jobId === 'dynamic')?.reason).toContain('inputs');
    expect(result.requiredChecks).toEqual(['build', 'lint-20', 'lint-22', 'call / inner']);
  });
});
