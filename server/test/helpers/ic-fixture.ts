import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { config } from '../../src/config.js';
import type { IcTask } from '../../src/external/ic-task.js';

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

// 按 Contracts 第 6 节的形状在 .work/ 下建一个 task 目录：起始仓库由真实 git 命令提交并打成 bundle
export async function buildFixtureTask(runId: string): Promise<IcTask> {
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
  return {
    id: 'w7-fixture',
    dir: taskDir,
    title: 'W7 fixture：subtract',
    ticket: {
      title: '给 math 模块增加 subtract',
      body: '在 `src/math.js` 中导出 `subtract(a, b)`，返回 `a - b`。',
      acceptanceCriteria: [
        'AC1 `subtract(5, 3)` 返回 `2` — verify: test',
        'AC2 CI 通过 — verify: CI',
      ],
    },
    repo: { path: 'repo.bundle', commit },
    hiddenTests: {
      dir: 'hidden-tests',
      command: 'npx vitest run test/hidden --reporter=junit --outputFile.junit={junitPath}',
      manifest: hiddenManifest,
    },
  };
}
