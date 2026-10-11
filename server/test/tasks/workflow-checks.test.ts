import { describe, expect, it } from 'vitest';
import { readRemoteWorkflow, readWorkflowFiles } from '../../src/external/github.js';
import { analyzeWorkflows, expandMatrix } from '../../src/tasks/workflow-checks.js';

// txehq/txe-workflow 的 main（2026-10-11），只读取
const TXE_WORKFLOW = 'txehq/txe-workflow';
const TXE_WORKFLOW_SHA = '3677eca8011db69f8ff50884e76db7b76f7023e5';

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
  it('txe-workflow：arc-linux-dind 的 job 列为无法运行，macos-15 的 matrix 实例进入 requiredChecks', async () => {
    const files = await readWorkflowFiles(TXE_WORKFLOW, TXE_WORKFLOW_SHA);
    expect(files.map((f) => f.path)).toEqual(['.github/workflows/ci.yml', '.github/workflows/release.yml']);
    const result = await analyzeWorkflows(files, readRemoteWorkflow);
    const byName = new Map(result.jobs.map((j) => [`${j.workflow} ${j.checkName ?? j.jobId}`, j]));
    for (const name of [
      'guard',
      'reproducible (arc-linux-dind)',
      'cross-platform-digest',
      'budgets',
      'supply-chain',
      'test (arc-linux-dind, x86_64-unknown-linux-gnu)',
    ]) {
      expect(byName.get(`.github/workflows/ci.yml ${name}`)).toMatchObject({
        status: 'self-hosted',
        runsOn: 'arc-linux-dind',
      });
    }
    expect(byName.get('.github/workflows/ci.yml test (macos-15, aarch64-apple-darwin)')).toMatchObject({
      status: 'required',
      runsOn: 'macos-15',
      onPush: false,
    });
    // release 只由 tag 推送与手动触发：自托管的 job 列为无法运行，其余（macos 的构建）不由 pull_request 触发
    const release = result.jobs.filter((j) => j.workflow === '.github/workflows/release.yml');
    expect(new Set(release.map((j) => j.status))).toEqual(new Set(['self-hosted', 'not-on-pr']));
    expect(release.every((j) => !j.onPush)).toBe(true);
    expect(result.requiredChecks).toEqual([
      'test (macos-15, aarch64-apple-darwin)',
      'reproducible (macos-15)',
      'fresh-install (macos-15)',
    ]);
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
    );
    const rows = result.jobs.map((j) => [j.workflow.replace('.github/workflows/', ''), j.checkName, j.status, j.onPush]);
    expect(rows).toEqual([
      ['broken.yml', null, 'invalid', false],
      ['ci.yml', 'build', 'required', true],
      ['ci.yml', 'deploy', 'self-hosted', false],
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
