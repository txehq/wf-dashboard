import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { config } from '../../src/config.js';
import { type IcTask, IcTaskDefinition, type IcTaskWithTests } from '../../src/tasks/schema.js';

export const fixtureDir = fileURLToPath(new URL('../fixtures/ic-task/', import.meta.url));

export const hiddenManifest = {
  'test/hidden/subtract.hidden.test.js': [
    'subtract(5, 3) returns 2',
    'subtract handles negatives',
    'add still works',
    'subtract(0.3, 0.1) returns exactly 0.2',
  ],
  'test/hidden/multiply.hidden.test.js': ['multiply(2, 3) returns 6', 'multiply by zero'],
  'test/hidden/divide.hidden.test.js': ['divide(6, 3) returns 2', 'divide by one'],
};

export function testRunId(prefix: string): string {
  return `${prefix}-${new Date().toISOString().replace(/[-:.TZ]/g, '')}`;
}

export const git = (cwd: string, args: string[]) =>
  execa('git', ['-c', 'user.name=wf-dashboard', '-c', 'user.email=wf-dashboard@local', ...args], {
    cwd,
  });

// 带隐藏测试的 task 去掉隐藏测试与 task 目录：按验收标准评分的 task 定义
export function withoutHiddenTests(task: IcTask, id: string): IcTaskDefinition {
  const definition: Partial<IcTask> = { ...task, id };
  delete definition.dir;
  delete definition.hiddenTests;
  return IcTaskDefinition.parse(definition);
}

// 按 Contracts 第 6 节的形状在 .work/ 下建一个 task 目录：起始仓库由真实 git 命令提交并打成 bundle
export async function buildFixtureTask(
  runId: string,
  timeoutSeconds = 600,
): Promise<IcTaskWithTests> {
  const root = path.join(config.repoRoot, '.work/test-tasks', runId);
  const source = path.join(root, 'source');
  const taskDir = path.join(root, 'task');
  fs.mkdirSync(taskDir, { recursive: true });
  fs.cpSync(path.join(fixtureDir, 'repo'), source, { recursive: true });
  await git(source, ['init', '-b', 'main']);
  await git(source, ['add', '-A']);
  await git(source, ['commit', '-m', 'chore: minimal node project with vitest and ci']);
  const commit = (await git(source, ['rev-parse', 'HEAD'])).stdout.trim();
  await git(source, ['bundle', 'create', path.join(taskDir, 'repo.bundle'), 'main']);
  fs.cpSync(path.join(fixtureDir, 'hidden-tests'), path.join(taskDir, 'hidden-tests'), {
    recursive: true,
  });
  fs.cpSync(
    path.join(fixtureDir, 'vitest.hidden.config.mjs'),
    path.join(taskDir, 'vitest.hidden.config.mjs'),
  );
  return {
    id: 'w7-fixture',
    kind: 'ic',
    dir: taskDir,
    title: 'W7 fixture：subtract',
    persona: 'math 模块的维护者，回答简短。',
    hiddenRequirements: '- subtract(a, b) 返回 a - b\n- 不新增依赖',
    ticket: {
      title: '给 math 模块增加 subtract',
      body: '在 `src/math.js` 中导出 `subtract(a, b)`，返回 `a - b`。',
      acceptanceCriteria: [
        'AC1 `subtract(5, 3)` 返回 `2` — verify: test',
        'AC2 CI 通过 — verify: CI',
      ],
    },
    repo: { path: 'repo.bundle', commit },
    requiredChecks: ['ci'],
    hiddenTests: {
      dir: 'hidden-tests',
      config: 'vitest.hidden.config.mjs',
      command:
        'npx vitest run test/hidden --config {configPath} --reporter=junit --outputFile.junit={junitPath}',
      timeoutSeconds,
      manifest: hiddenManifest,
    },
  };
}
