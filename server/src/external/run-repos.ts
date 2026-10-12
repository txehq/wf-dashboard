import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execa } from 'execa';
import type { RepoTask } from '../tasks/schema.js';
import {
  createEmptyRunRepo,
  createRunRepo,
  prepareCopySeed,
  prepareEmptySeed,
  pushSeed,
  type RunRepo,
  seedDir,
} from './github.js';

// run 与 isolated 交互的仓库（Contracts 7.2）：GitHub txehq，或本地仓库模式下 config.localReposDir 中的 bare 仓库
export interface RunRepos {
  // 本地仓库模式的目录；GitHub 时为 null
  localDir: string | null;
  createEmpty(runId: string, signal: AbortSignal): Promise<RunRepo>;
  createCopy(task: RepoTask, runId: string, signal: AbortSignal): Promise<RunRepo>;
  clone(repo: string, dest: string, signal: AbortSignal): Promise<void>;
}

export const githubRepos: RunRepos = {
  localDir: null,
  createEmpty: createEmptyRunRepo,
  createCopy: createRunRepo,
  async clone(repo, dest, signal) {
    await execa('gh', ['repo', 'clone', repo, dest], { cancelSignal: signal });
  },
};

// bare 仓库 <dir>/wfe-<runId>.git：内容与 GitHub 副本相同，没有 ruleset；repo 为它的绝对路径
export function localRepos(dir: string): RunRepos {
  async function publish(runId: string, seed: string, head: string): Promise<RunRepo> {
    const repo = path.join(dir, `wfe-${runId}.git`);
    if (fs.existsSync(repo)) throw new Error(`本地仓库已存在：${repo}`);
    fs.mkdirSync(dir, { recursive: true });
    await execa('git', ['init', '--quiet', '--bare', '--initial-branch', 'main', repo]);
    await pushSeed(seed, repo);
    fs.rmSync(seed, { recursive: true });
    const mainSha = (await execa('git', ['-C', repo, 'rev-parse', 'refs/heads/main'])).stdout;
    if (mainSha !== head) throw new Error(`${repo} main 在 ${mainSha}，应为 ${head}`);
    return { repo, url: repoLocation(repo), mainSha };
  }
  return {
    localDir: dir,
    async createEmpty(runId) {
      const seed = seedDir(runId);
      return publish(runId, seed, await prepareEmptySeed(runId, seed));
    },
    async createCopy(task, runId) {
      const seed = seedDir(runId);
      return publish(runId, seed, await prepareCopySeed(task, seed));
    },
    async clone(repo, dest, signal) {
      await execa('git', ['clone', '--quiet', repo, dest], { cancelSignal: signal });
    },
  };
}

export const runReposFor = (localDir: string | null): RunRepos =>
  localDir === null ? githubRepos : localRepos(localDir);

// runs.github_repo 是本地仓库模式的 bare 仓库（绝对路径）时为 true；GitHub 仓库是 owner/name
export const isLocalRepo = (repo: string) => path.isAbsolute(repo);

// 仓库的地址：GitHub 的网页地址，或本地 bare 仓库的 file:// 地址
export const repoLocation = (repo: string) =>
  isLocalRepo(repo) ? pathToFileURL(repo).href : `https://github.com/${repo}`;
