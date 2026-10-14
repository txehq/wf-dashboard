import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import type { WorktreeStep } from './views.js';

export const MAGI_BRANCH = 'magi-agent';
export const MAIN_BRANCH = 'main';

// 运行一条命令，返回退出码与 stdout、stderr 合在一起的原文；失败与否由调用方按退出码判断
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

// 一条必须成功的命令：失败时以命令与原文报错
async function must(cwd: string, file: string, args: string[]): Promise<string> {
  const result = await exec(cwd, file, args);
  if (!result.ok) throw new Error(`${file} ${args.join(' ')}（${cwd}）失败：\n${result.output}`);
  return result.output;
}

// worktree 已建好并装好依赖
export function worktreeReady(worktree: string): boolean {
  return (
    fs.existsSync(path.join(worktree, '.git')) && fs.existsSync(path.join(worktree, 'node_modules'))
  );
}

export function initialWorktreeSteps(): WorktreeStep[] {
  return [
    {
      id: 'worktree',
      label: `建 worktree（分支 ${MAGI_BRANCH}）`,
      status: 'pending',
      output: null,
    },
    { id: 'install', label: 'pnpm install', status: 'pending', output: null },
  ];
}

// 一步准备：worktree 从 main 的 HEAD 建（分支已存在时用已有的分支）；之后 pnpm install。已经做过的步骤跳过
export async function runWorktreeStep(
  step: WorktreeStep['id'],
  repoDir: string,
  worktree: string,
): Promise<{ ok: boolean; output: string }> {
  if (step === 'worktree') {
    if (fs.existsSync(path.join(worktree, '.git'))) {
      return { ok: true, output: `${worktree} 已存在` };
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
    return { ok: true, output: '依赖已安装' };
  }
  return exec(worktree, 'pnpm', ['install']);
}

// worktree 中未提交的文件（git status --porcelain 的每一行）
export async function uncommittedFiles(worktree: string): Promise<string[]> {
  const output = await must(worktree, 'git', ['status', '--porcelain']);
  return output.split('\n').filter((line) => line.trim() !== '');
}

// magi-agent 相对 main 领先与落后的 commit 数（git rev-list --left-right --count 的两个数）
export async function aheadBehind(repoDir: string): Promise<{ ahead: number; behind: number }> {
  const output = await must(repoDir, 'git', [
    'rev-list',
    '--left-right',
    '--count',
    `${MAIN_BRANCH}...${MAGI_BRANCH}`,
  ]);
  const [behind, ahead] = output.trim().split(/\s+/).map(Number);
  if (behind === undefined || ahead === undefined || Number.isNaN(behind + ahead)) {
    throw new Error(`git rev-list --left-right --count 的输出不是两个数：${output}`);
  }
  return { ahead, behind };
}
