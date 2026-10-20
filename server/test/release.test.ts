import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { createVariants } from '../src/variants/index.js';
import {
  createReleaseCheck,
  RELEASE_REPO,
  releaseArgs,
  releaseCommit,
  releaseFrom,
} from '../src/variants/release.js';
import { createWorkflows } from '../src/workflows/index.js';
import { recordedRelease, releaseRepos } from './helpers/release-fixtures.js';

// Contracts 29.1 中读取最新版与取 commit 的部分：录下的真实 gh 输出，.work/ 下由测试建的本地仓库（一个提交）。
// 导入与构建见 release-import.test.ts（慢档）
const dir = path.join(config.dataDir, `release-${randomUUID().slice(0, 8)}`);
const git = async (cwd: string, args: string[]) =>
  (await execa('git', ['-C', cwd, ...args])).stdout.trim();

async function sourceRepo(name: string): Promise<{ source: string; commit: string }> {
  const source = path.join(dir, name, 'source');
  fs.mkdirSync(source, { recursive: true });
  await git(source, ['init', '--quiet', '--initial-branch=main']);
  fs.writeFileSync(path.join(source, 'README.md'), 'release test\n');
  await git(source, ['add', 'README.md']);
  await git(source, [
    '-c',
    'user.name=wfd',
    '-c',
    'user.email=wfd@example.com',
    'commit',
    '--quiet',
    '-m',
    'one',
  ]);
  return { source, commit: await git(source, ['rev-parse', 'HEAD']) };
}

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('读取 Latest release', () => {
  test('录下的 gh 输出：tag 与发布时间；参数与当前的命令相同', () => {
    const latest = recordedRelease('latest');
    expect(latest.args).toEqual(releaseArgs(RELEASE_REPO, null));
    expect(releaseFrom(latest.args, latest.result)).toEqual({
      tag: 'v2.3.0',
      publishedAt: new Date('2026-10-07T13:25:16Z'),
    });
    const older = recordedRelease('older');
    expect(older.args).toEqual(releaseArgs(RELEASE_REPO, 'v2.2.2'));
    expect(releaseFrom(older.args, older.result).tag).toBe('v2.2.2');
  });

  test('gh 失败时以 stderr 原文失败', () => {
    const missing = recordedRelease('missing-repo');
    expect(() => releaseFrom(missing.args, missing.result)).toThrow(
      'gh release view --repo txehq/wfd-no-such-repo-w91 --json tagName,publishedAt 退出码 1：release not found',
    );
  });
});

describe('release 的 commit', () => {
  test('本地没有这个 tag 时只 fetch 这一个 tag，不改分支与工作区；有了之后不再 fetch', async () => {
    const { source, commit } = await sourceRepo('fetch');
    const { origin, work } = await releaseRepos(source, path.join(dir, 'fetch'), [
      { tag: 'v2.3.0', commit },
      { tag: 'v2.2.2', commit },
    ]);
    const state = async () => ({
      head: await git(work, ['rev-parse', 'HEAD']),
      branch: await git(work, ['symbolic-ref', 'HEAD']),
      branches: await git(work, ['for-each-ref', 'refs/heads', 'refs/remotes']),
      status: await git(work, ['status', '--porcelain']),
    });
    const before = await state();
    expect(await git(work, ['tag', '--list'])).toBe('');

    expect(await releaseCommit(work, 'v2.3.0')).toBe(commit);
    expect(await git(work, ['tag', '--list'])).toBe('v2.3.0');
    expect(await state()).toEqual(before);

    // origin 不可达时仍然取得到：本地已有这个 tag，不再 fetch
    await git(work, ['remote', 'set-url', 'origin', path.join(dir, 'gone.git')]);
    expect(await releaseCommit(work, 'v2.3.0')).toBe(commit);
    await expect(releaseCommit(work, 'v2.2.2')).rejects.toThrow(/gone\.git/);
    expect(fs.existsSync(origin)).toBe(true);
  });
});

describe('检查失败的原文', () => {
  test('gh 失败与 fetch 失败都记在 lfg、ic 的 release.error 中，读到过的 tag 保留，不导入 variant', async () => {
    const db = openDatabase(path.join(dir, 'db.sqlite'), config.migrationsDir);
    const variants = createVariants({
      db,
      dataDir: path.join(dir, 'data'),
      repo: path.join(dir, 'unused'),
      ctxBin: config.ctxBin,
    });
    const workflows = createWorkflows({ db, variants });
    expect(workflows.get('lfg').release).toBeNull();

    // origin 中没有 v2.3.0：读到了 tag，fetch 失败
    const { source } = await sourceRepo('no-tag');
    const { work } = await releaseRepos(source, path.join(dir, 'no-tag'), []);
    await createReleaseCheck({
      db,
      variants,
      repo: work,
      readRelease: () => Promise.resolve(recordedRelease('latest')),
    }).check();
    for (const id of ['lfg', 'ic']) {
      const release = workflows.get(id).release;
      expect(release).toMatchObject({
        tag: 'v2.3.0',
        publishedAt: Date.parse('2026-10-07T13:25:16Z'),
        variantId: null,
      });
      expect(release?.error).toMatch(/git -C .* fetch origin tag v2\.3\.0 --no-tags/);
      expect(release?.error).toMatch(/couldn't find remote ref|not found/i);
    }

    // gh 失败：error 换成 gh 的原文，上次读到的 tag 保留
    await createReleaseCheck({
      db,
      variants,
      repo: work,
      readRelease: () => Promise.resolve(recordedRelease('missing-repo')),
    }).check();
    const lfg = workflows.get('lfg').release;
    expect(lfg).toMatchObject({ tag: 'v2.3.0', variantId: null });
    expect(lfg?.error).toBe(
      'gh release view --repo txehq/wfd-no-such-repo-w91 --json tagName,publishedAt 退出码 1：release not found',
    );
    expect(workflows.get('session-analysis').release).toBeNull();
    expect(variants.list()).toEqual([]);
    db.$client.close();
  });
});
