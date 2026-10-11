import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { bundleHead, readCommit } from '../../src/external/github.js';
import { ensureImportedBundle } from '../../src/tasks/linear-import.js';
import type { IcTaskDefinition } from '../../src/tasks/schema.js';
import { testRunId } from '../helpers/ic-fixture.js';

// 一个很小的真实公开仓库（两个 commit），只读取
const REPO = 'txehq/take-home-question';
const FIRST = 'f053065ed9a0a2004b3de77793f5c3892bebf0b0';
const SECOND = '8f2186115f8dd3c84f90a51b431153047b2c2f0c';

function importedTask(commit: string): IcTaskDefinition {
  return {
    id: 'ic-bundle-probe',
    kind: 'ic',
    title: 'bundle',
    persona: 'p',
    hiddenRequirements: 'h',
    source: {
      linear: { identifier: 'TXE-1', url: 'https://linear.app/capso/issue/TXE-1' },
      github: { repo: REPO },
    },
    ticket: { title: 't', body: 'b', acceptanceCriteria: ['a'] },
    repo: { path: 'repo.bundle', commit },
    requiredChecks: [],
  };
}

describe('从源仓库生成 repo.bundle（真实 GitHub）', { timeout: 5 * 60_000 }, () => {
  it('在所选 commit 生成 bundle，main 指向它；换 commit 后重新生成，相同 commit 不重做', async () => {
    const tasksDir = path.join(config.repoRoot, '.work/test-tasks', testRunId('w28-bundle'));
    const bundle = path.join(tasksDir, 'ic-bundle-probe', 'repo.bundle');

    await ensureImportedBundle(importedTask(FIRST), tasksDir);
    expect(await bundleHead(bundle)).toBe(FIRST);
    const clone = path.join(tasksDir, 'clone-first');
    await execa('git', ['clone', '--quiet', bundle, clone]);
    expect((await execa('git', ['-C', clone, 'rev-list', '--count', 'HEAD'])).stdout).toBe('1');
    expect(fs.existsSync(path.join(clone, 'README.md'))).toBe(true);

    const before = fs.statSync(bundle).mtimeMs;
    await ensureImportedBundle(importedTask(FIRST), tasksDir);
    expect(fs.statSync(bundle).mtimeMs).toBe(before);

    await ensureImportedBundle(importedTask(SECOND), tasksDir);
    expect(await bundleHead(bundle)).toBe(SECOND);
    const second = path.join(tasksDir, 'clone-second');
    await execa('git', ['clone', '--quiet', bundle, second]);
    expect((await execa('git', ['-C', second, 'log', '--format=%H'])).stdout.split('\n')).toEqual([
      SECOND,
      FIRST,
    ]);
    expect((await readCommit(REPO, SECOND)).title).toBe('Update README.md');
    // 临时的 bare 克隆已删除，bundle 旁没有临时文件
    expect(fs.readdirSync(path.dirname(bundle))).toEqual(['repo.bundle']);
  });
});
