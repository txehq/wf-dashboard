import fs from 'node:fs';
import path from 'node:path';
import { execaSync } from 'execa';

// 不读取 config：调用方在加载服务端模块之前用它设置 WFD_CODEX_SKILL_SOURCES 与 WFD_CODEX_BIN

const fixtures = path.resolve(import.meta.dirname, '../fixtures/codex/skills');

// Codex 会话的替身命令（只验证页面与 API，不验证 Codex 本身）：写出与 codex-cli 0.162.0 相同形状的会话记录
export const codexStandIn = path.resolve(
  import.meta.dirname,
  '../fixtures/codex/codex-stand-in.mjs',
);

// 每个 fixture skill 一个本地 git 仓库（skills/<名字>/SKILL.md），作为 npx skills add 的来源（不依赖网络）
export function makeSkillSources(dir: string): { name: string; source: string }[] {
  return fs.readdirSync(fixtures).map((name) => {
    const repo = path.join(dir, name);
    fs.rmSync(repo, { recursive: true, force: true });
    fs.mkdirSync(path.join(repo, 'skills'), { recursive: true });
    fs.cpSync(path.join(fixtures, name), path.join(repo, 'skills', name), { recursive: true });
    const git = (...args: string[]) =>
      execaSync('git', [
        '-C',
        repo,
        '-c',
        'user.name=wf-dashboard',
        '-c',
        'user.email=wf@example.invalid',
        ...args,
      ]);
    git('init', '--quiet', '--initial-branch', 'main');
    git('add', '.');
    git('commit', '--quiet', '-m', name);
    return { name, source: repo };
  });
}
