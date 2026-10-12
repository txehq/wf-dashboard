import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { bundleHead, readCommit } from '../../src/external/github.js';
import { ensureImportedBundle } from '../../src/tasks/linear-import.js';
import type { IcTaskDefinition } from '../../src/tasks/schema.js';
import { testRunId } from '../helpers/ic-fixture.js';
import { IMPORT_SOURCE } from '../helpers/import-source.js';

function importedTask(repo: string, commit: string): IcTaskDefinition {
  return {
    id: 'ic-bundle-probe',
    kind: 'ic',
    title: 'bundle',
    persona: 'p',
    hiddenRequirements: 'h',
    source: {
      linear: { identifier: 'TXE-3777', url: 'https://linear.app/capso/issue/TXE-3777' },
      github: { repo, prs: [] },
    },
    ticket: { title: 't', body: 'b', acceptanceCriteria: ['a'] },
    repo: { path: 'repo.bundle', commit },
    requiredChecks: [],
  };
}

// 源仓库是已存在的 txehq/txe-workflow，只克隆读取
describe('从源仓库生成 repo.bundle（真实 GitHub，只读）', { timeout: 5 * 60_000 }, () => {
  it('在所选 commit 生成 bundle，main 指向它；换 commit 后重新生成，相同 commit 不重做', async () => {
    const tasksDir = path.join(config.repoRoot, '.work/test-tasks', testRunId('w28-bundle'));
    const bundle = path.join(tasksDir, 'ic-bundle-probe', 'repo.bundle');
    const { repo, parent: first, commit: second } = IMPORT_SOURCE;

    await ensureImportedBundle(importedTask(repo, first), tasksDir);
    expect(await bundleHead(bundle)).toBe(first);
    const cloneFirst = path.join(tasksDir, 'clone-first');
    await execa('git', ['clone', '--quiet', bundle, cloneFirst]);
    expect((await execa('git', ['-C', cloneFirst, 'rev-list', '--count', 'HEAD'])).stdout).toBe(
      String(IMPORT_SOURCE.commits - 1),
    );

    const before = fs.statSync(bundle).mtimeMs;
    await ensureImportedBundle(importedTask(repo, first), tasksDir);
    expect(fs.statSync(bundle).mtimeMs).toBe(before);

    await ensureImportedBundle(importedTask(repo, second), tasksDir);
    expect(await bundleHead(bundle)).toBe(second);
    const cloneSecond = path.join(tasksDir, 'clone-second');
    await execa('git', ['clone', '--quiet', bundle, cloneSecond]);
    expect(
      (await execa('git', ['-C', cloneSecond, 'log', '-2', '--format=%H'])).stdout.split('\n'),
    ).toEqual([second, first]);
    expect((await readCommit(repo, second)).title).toMatch(/^fix\(fix-pr\): what the third review/);
    // 临时克隆目录已删除，bundle 旁没有其他文件
    expect(fs.readdirSync(path.dirname(bundle))).toEqual(['repo.bundle']);
  });

  it('克隆失败：仓库不存在或 commit 不存在时以原文报错，临时目录被删除，没有留下 bundle', async () => {
    const tasksDir = path.join(config.repoRoot, '.work/test-tasks', testRunId('w29-clone-fail'));
    const taskDir = path.join(tasksDir, 'ic-bundle-probe');
    const missingRepo = `txehq/wfe-test-missing-${testRunId('x').slice(2)}`;
    await expect(
      ensureImportedBundle(importedTask(missingRepo, IMPORT_SOURCE.commit), tasksDir),
    ).rejects.toThrow(/gh repo clone .*Could not resolve to a Repository/s);
    expect(fs.readdirSync(taskDir)).toEqual([]);

    const missingCommit = 'f'.repeat(40);
    await expect(
      ensureImportedBundle(importedTask(IMPORT_SOURCE.repo, missingCommit), tasksDir),
    ).rejects.toThrow(new RegExp(`git -C .* fetch --quiet origin ${missingCommit}`));
    expect(fs.readdirSync(taskDir)).toEqual([]);
  });
});
