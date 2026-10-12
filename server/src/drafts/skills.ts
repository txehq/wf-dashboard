import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { z } from 'zod';
import { config } from '../config.js';
import type { DraftSkillVersion } from '../db/schema.js';
import type { DraftLayout } from './dir.js';

// skills CLI（npx skills）随服务端安装，不在运行时从 npm 下载
const skillsBin = path.join(config.repoRoot, 'server/node_modules/.bin/skills');

const SkillsLock = z.looseObject({
  skills: z.record(z.string(), z.looseObject({ computedHash: z.string().min(1) })),
});

// 准备草稿时安装 Codex 用的一个 skill（Contracts 17.3）：在草稿目录中以项目范围运行
// npx skills add <来源> --skill <名字> -a codex，装到 <草稿目录>/.agents/skills/；
// 版本为 skills-lock.json 的 computedHash 与安装时来源的 HEAD commit
export async function installCodexSkill(
  layout: DraftLayout,
  { name, source }: { name: string; source: string },
): Promise<DraftSkillVersion> {
  // skills CLI 在 TMPDIR 中 clone 来源；HOME 为草稿自己的 home/，不碰用户的 ~/.agents
  const tmp = path.join(layout.dir, '.skills-tmp');
  fs.mkdirSync(tmp, { recursive: true });
  fs.mkdirSync(layout.home, { recursive: true });
  const head = await execa('git', ['ls-remote', source, 'HEAD']);
  const commit = head.stdout.split('\t')[0] ?? '';
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`git ls-remote ${source} HEAD 没有返回 commit：${head.stdout}`);
  }
  await execa(skillsBin, ['add', source, '--skill', name, '-a', 'codex', '-y', '--copy'], {
    cwd: layout.dir,
    env: {
      HOME: layout.home,
      TMPDIR: tmp,
      npm_config_cache: path.join(os.homedir(), '.npm'),
      DO_NOT_TRACK: '1',
    },
    stdin: 'ignore',
  });
  fs.rmSync(tmp, { recursive: true, force: true });
  if (!fs.existsSync(path.join(layout.agentSkills, name, 'SKILL.md'))) {
    throw new Error(
      `npx skills add ${source} --skill ${name} 之后没有 ${layout.agentSkills}/${name}/SKILL.md`,
    );
  }
  const lock = SkillsLock.parse(JSON.parse(fs.readFileSync(layout.skillsLock, 'utf8')));
  const entry = lock.skills[name];
  if (entry === undefined) throw new Error(`${layout.skillsLock} 中没有 ${name}`);
  return { name, source, computedHash: entry.computedHash, commit };
}
