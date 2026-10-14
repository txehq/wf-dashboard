import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';

// Magi Agent 测试的"主仓库"：本地 git 仓库（main 分支），有 agent/MAGI.md 与一个没有依赖的 pnpm 工作区，
// pnpm install 在其中很快完成，并且不会找到外面 wf-dashboard 的工作区。不碰真实的主仓库与 wf-dashboard-magi-agent
export const MAGI_TEXT =
  '# Magi Agent 测试说明\n\n这是测试仓库中的 MAGI.md，"引号" 与 \\ 反斜杠原样传入。\n';

export async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execa(
    'git',
    ['-c', 'user.name=magi-test', '-c', 'user.email=magi@test', ...args],
    { cwd },
  );
  return stdout;
}

export async function createMagiRepo(dir: string): Promise<void> {
  fs.mkdirSync(path.join(dir, 'agent'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent', 'MAGI.md'), MAGI_TEXT);
  fs.writeFileSync(path.join(dir, 'package.json'), '{ "name": "magi-test", "private": true }\n');
  fs.writeFileSync(path.join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
  fs.writeFileSync(path.join(dir, 'README.md'), '测试仓库\n');
  fs.writeFileSync(path.join(dir, '.gitignore'), 'node_modules/\n');
  await git(dir, 'init', '-q', '-b', 'main');
  // 与真实仓库相同，pnpm-lock.yaml 已提交：worktree 中的 pnpm install 不留下未跟踪的文件
  await execa('pnpm', ['install'], { cwd: dir });
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-q', '-m', '初始');
}
