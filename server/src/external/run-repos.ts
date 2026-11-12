import { execa } from 'execa';
import type { RepoTask } from '../tasks/schema.js';
import { createEmptyRunRepo, createRunRepo, type RunRepo } from './github.js';

// Repos that runs and isolated interact with (Contracts 7.2): GitHub txehq
export interface RunRepos {
  createEmpty(runId: string, signal: AbortSignal): Promise<RunRepo>;
  createCopy(task: RepoTask, runId: string, signal: AbortSignal): Promise<RunRepo>;
  clone(repo: string, dest: string, signal: AbortSignal): Promise<void>;
}

export const githubRepos: RunRepos = {
  createEmpty: createEmptyRunRepo,
  createCopy: createRunRepo,
  async clone(repo, dest, signal) {
    await execa('gh', ['repo', 'clone', repo, dest], { cancelSignal: signal });
  },
};

// The repo's location: its GitHub web URL
export const repoLocation = (repo: string) => `https://github.com/${repo}`;
