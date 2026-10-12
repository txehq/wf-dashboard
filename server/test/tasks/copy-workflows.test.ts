import { describe, expect, it } from 'vitest';
import { copyCommitBody, copyWorkflow, copyWorkflows } from '../../src/tasks/copy-workflows.js';

const ci = `# 合并前的检查（注释保留）
name: ci

on:
  # PR 上运行
  pull_request:
    branches: [main] # 只看指向 main 的 PR
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - run: echo "ci ok" # 行尾注释
      - run: |
          echo "多行"
          echo "脚本"
`;

describe('副本的 workflow：on 只保留 pull_request', () => {
  it('映射形式：去掉 push 与 workflow_dispatch，pull_request 的过滤条件、注释与格式原样保留', () => {
    const change = copyWorkflow({ path: '.github/workflows/ci.yml', content: ci });
    expect(change).toEqual({
      kind: 'rewritten',
      path: '.github/workflows/ci.yml',
      removed: ['push', 'workflow_dispatch'],
      content: `# 合并前的检查（注释保留）
name: ci

on:
  # PR 上运行
  pull_request:
    branches: [main] # 只看指向 main 的 PR

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - run: echo "ci ok" # 行尾注释
      - run: |
          echo "多行"
          echo "脚本"
`,
    });
  });

  it('列表与单个事件名；只有 pull_request 的文件不改；没有 pull_request 的文件删除', () => {
    expect(
      copyWorkflow({ path: '.github/workflows/a.yml', content: 'on: [push, pull_request]\njobs: {}\n' }),
    ).toEqual({
      kind: 'rewritten',
      path: '.github/workflows/a.yml',
      removed: ['push'],
      content: 'on: [pull_request]\njobs: {}\n',
    });
    expect(copyWorkflow({ path: '.github/workflows/b.yml', content: 'on: pull_request\njobs: {}\n' })).toEqual({
      kind: 'kept',
      path: '.github/workflows/b.yml',
    });
    expect(
      copyWorkflow({
        path: '.github/workflows/scheduled.yml',
        content: "on:\n  schedule:\n    - cron: '17 3 1 1 *'\n  workflow_dispatch:\njobs: {}\n",
      }),
    ).toEqual({
      kind: 'deleted',
      path: '.github/workflows/scheduled.yml',
      removed: ['schedule', 'workflow_dispatch'],
    });
    expect(copyWorkflow({ path: '.github/workflows/release.yml', content: 'on: push\njobs: {}\n' })).toEqual({
      kind: 'deleted',
      path: '.github/workflows/release.yml',
      removed: ['push'],
    });
  });

  it('块状列表与 flow 映射；多行的纯量原样保留（只删行，不重新序列化）', () => {
    expect(
      copyWorkflow({
        path: '.github/workflows/c.yml',
        content: 'on:\n  - push\n  - pull_request # PR\njobs:\n  x:\n    if: >-\n      a &&\n      b\n',
      }),
    ).toMatchObject({
      kind: 'rewritten',
      content: 'on:\n  - pull_request # PR\njobs:\n  x:\n    if: >-\n      a &&\n      b\n',
    });
    expect(
      copyWorkflow({
        path: '.github/workflows/d.yml',
        content:
          'on: { push: { branches: [main] }, pull_request: { branches: [main] } }\njobs:\n  x:\n    options: >\n      --a\n      --b\n    run: docker run\n      --rm\n',
      }),
    ).toMatchObject({
      kind: 'rewritten',
      content:
        'on: { pull_request: { branches: [main] } }\njobs:\n  x:\n    options: >\n      --a\n      --b\n    run: docker run\n      --rm\n',
    });
  });

  it('workflow_call 保留（被 pull_request workflow 调用的 reusable workflow 不能删）', () => {
    expect(
      copyWorkflow({
        path: '.github/workflows/reusable.yml',
        content: 'on:\n  workflow_call:\n  workflow_dispatch:\njobs: {}\n',
      }),
    ).toMatchObject({ kind: 'rewritten', removed: ['workflow_dispatch'], content: 'on:\n  workflow_call:\njobs: {}\n' });
  });

  it('只处理 .github/workflows/ 下一层的文件；commit 正文列出删除的文件与去掉的触发方式', () => {
    const changes = copyWorkflows([
      { path: '.github/workflows/ci.yml', content: ci },
      { path: '.github/workflows/only-pr.yml', content: 'on: pull_request\njobs: {}\n' },
      { path: '.github/workflows/scheduled.yml', content: 'on: schedule\njobs: {}\n' },
      { path: '.github/workflows/nested/x.yml', content: 'on: push\njobs: {}\n' },
    ]);
    expect(changes.map((c) => [c.kind, c.path])).toEqual([
      ['rewritten', '.github/workflows/ci.yml'],
      ['deleted', '.github/workflows/scheduled.yml'],
    ]);
    expect(copyCommitBody(changes)).toBe(
      '- .github/workflows/ci.yml：去掉 push、workflow_dispatch\n- 删除 .github/workflows/scheduled.yml（触发方式：schedule）',
    );
    expect(copyWorkflows([{ path: '.github/workflows/only-pr.yml', content: 'on: pull_request\n' }])).toEqual([]);
  });
});
