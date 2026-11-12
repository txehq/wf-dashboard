import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import type { WorktreeStep } from './views.js';

export const MAGI_BRANCH = 'magi-agent';
export const MAIN_BRANCH = 'main';

// Runs a command and returns the exit status with stdout and stderr combined as written; the caller decides from the
// exit code whether it failed
export async function exec(
  cwd: string,
  file: string,
  args: string[],
  env?: Record<string, string>,
): Promise<{ ok: boolean; output: string }> {
  const result = await execa(file, args, {
    cwd,
    all: true,
    reject: false,
    ...(env === undefined ? {} : { env, extendEnv: false }),
  });
  return { ok: result.exitCode === 0, output: result.all };
}

// A command that must succeed: on failure, throws with the command and its output
async function must(cwd: string, file: string, args: string[]): Promise<string> {
  const result = await exec(cwd, file, args);
  if (!result.ok) throw new Error(`${file} ${args.join(' ')} (${cwd}) failed:\n${result.output}`);
  return result.output;
}

// The worktree is created and its dependencies installed
export function worktreeReady(worktree: string): boolean {
  return (
    fs.existsSync(path.join(worktree, '.git')) && fs.existsSync(path.join(worktree, 'node_modules'))
  );
}

export function initialWorktreeSteps(): WorktreeStep[] {
  return [
    {
      id: 'worktree',
      label: `Create the worktree (branch ${MAGI_BRANCH})`,
      status: 'pending',
      output: null,
    },
    { id: 'install', label: 'pnpm install', status: 'pending', output: null },
  ];
}

// One preparation step: the worktree is created from main's HEAD (using the branch when it already exists); then pnpm
// install. Steps already done are skipped
export async function runWorktreeStep(
  step: WorktreeStep['id'],
  repoDir: string,
  worktree: string,
): Promise<{ ok: boolean; output: string }> {
  if (step === 'worktree') {
    if (fs.existsSync(path.join(worktree, '.git'))) {
      return { ok: true, output: `${worktree} already exists` };
    }
    const branch = await exec(repoDir, 'git', [
      'rev-parse',
      '--verify',
      '--quiet',
      `refs/heads/${MAGI_BRANCH}`,
    ]);
    return exec(
      repoDir,
      'git',
      branch.ok
        ? ['worktree', 'add', worktree, MAGI_BRANCH]
        : ['worktree', 'add', '-b', MAGI_BRANCH, worktree, MAIN_BRANCH],
    );
  }
  if (fs.existsSync(path.join(worktree, 'node_modules'))) {
    return { ok: true, output: 'Dependencies already installed' };
  }
  return exec(worktree, 'pnpm', ['install']);
}

// Uncommitted files in the worktree (each line of git status --porcelain)
export async function uncommittedFiles(worktree: string): Promise<string[]> {
  const output = await must(worktree, 'git', ['status', '--porcelain']);
  return output.split('\n').filter((line) => line.trim() !== '');
}

// Commits magi-agent is ahead of and behind main (the two numbers of git rev-list --left-right --count)
export async function aheadBehind(repoDir: string): Promise<{ ahead: number; behind: number }> {
  const output = await must(repoDir, 'git', [
    'rev-list',
    '--left-right',
    '--count',
    `${MAIN_BRANCH}...${MAGI_BRANCH}`,
  ]);
  const [behind, ahead] = output.trim().split(/\s+/).map(Number);
  if (behind === undefined || ahead === undefined || Number.isNaN(behind + ahead)) {
    throw new Error(
      `The output of git rev-list --left-right --count is not two numbers: ${output}`,
    );
  }
  return { ahead, behind };
}
