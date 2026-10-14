import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { claudeSettingsEnv } from '../llm/client.js';

// dashboard 所有的 Claude Code 配置目录（CLAUDE_CONFIG_DIR）：variant 的隔离配置（7.10、14.2）与
// 设计、分析优化会话自己的 claude-config/（Contracts 22.2）共用的写法

const IsolatedSettings = z.looseObject({
  env: z.record(z.string(), z.unknown()).optional(),
  claudeMdExcludes: z.array(z.string()).optional(),
});
export type IsolatedSettings = z.infer<typeof IsolatedSettings>;

const ClaudeState = z.looseObject({
  hasCompletedOnboarding: z.boolean().optional(),
  // 按目录记录的状态；信任确认记在 projects[<目录>].hasTrustDialogAccepted（Reports/W39 实测，祖先目录的信任也覆盖子目录）
  projects: z
    .record(z.string(), z.looseObject({ hasTrustDialogAccepted: z.boolean().optional() }))
    .optional(),
});

function writeAtomic(file: string, value: unknown) {
  // 先写临时文件再 rename：并发启动的进程不会读到写了一半的文件
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// 把 settings 源的 env 块（认证与 gateway 模型别名）合并进 <claudeDir>/settings.json，其他字段原样保留；
// 返回合并的键
export function writeIsolatedSettings(
  claudeDir: string,
  settingsPath: string | undefined,
  edit: (settings: IsolatedSettings) => void = () => undefined,
): string[] {
  const file = path.join(claudeDir, 'settings.json');
  const settings = IsolatedSettings.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  const sourceEnv = claudeSettingsEnv(settingsPath);
  settings.env = { ...settings.env, ...sourceEnv };
  edit(settings);
  writeAtomic(file, settings);
  return Object.keys(sourceEnv);
}

// cwd 在 $HOME 之下时，真实 ~/.claude/CLAUDE.md 会被当作祖先目录的文件读入
export function realClaudeMdExcludes(home = os.homedir()): string[] {
  return [path.join(home, '.claude/CLAUDE.md'), path.join(home, '.claude/rules/**')];
}

// Claude Code 的首次引导（主题、安全提示）只在交互启动时出现，状态记在 <CLAUDE_CONFIG_DIR>/.claude.json；
// 配置目录由 dashboard 所有，写入引导已完成（Contracts 14.2）。已经写过时不改动文件
export function markOnboardingDone(claudeDir: string) {
  const file = path.join(claudeDir, '.claude.json');
  const state = fs.existsSync(file)
    ? ClaudeState.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
    : {};
  if (state.hasCompletedOnboarding === true) return;
  writeAtomic(file, { ...state, hasCompletedOnboarding: true });
}

// 启动与 resume 前把 cwd 记为已信任（Contracts 14.2），Claude Code 不再询问；已信任时不改动文件。
// cwd 经过符号链接时，原路径与真实路径都记上
export function trustDirectory(claudeDir: string, cwd: string) {
  const file = path.join(claudeDir, '.claude.json');
  const state = ClaudeState.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  const dirs = [...new Set([path.resolve(cwd), fs.realpathSync(cwd)])];
  const projects = { ...state.projects };
  if (dirs.every((d) => projects[d]?.hasTrustDialogAccepted === true)) return;
  for (const d of dirs) projects[d] = { ...projects[d], hasTrustDialogAccepted: true };
  writeAtomic(file, { ...state, projects });
}

// 父进程是 Claude Code 或 Orca 时，这些变量会覆盖子进程的隔离设置
export function isolatedBaseEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        !entry[0].startsWith('CLAUDE') &&
        !entry[0].startsWith('ANTHROPIC') &&
        !entry[0].startsWith('ORCA_AGENT'),
    ),
  );
}

// 设计与分析优化会话的配置目录（Contracts 22.2）：每次启动与 resume 前写一遍——凭据与模型配置（认证可能变了）、
// 不读真实的 CLAUDE.md、引导已完成、工作目录已信任。模型不写，取 settings 源 env 中本机 Claude Code 的默认模型
export function writeSessionClaudeConfig(
  claudeDir: string,
  cwd: string,
  settingsPath: string | undefined,
): string[] {
  fs.mkdirSync(claudeDir, { recursive: true });
  const file = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(file)) writeAtomic(file, {});
  const merged = writeIsolatedSettings(claudeDir, settingsPath, (settings) => {
    settings.claudeMdExcludes = realClaudeMdExcludes();
  });
  markOnboardingDone(claudeDir);
  trustDirectory(claudeDir, cwd);
  return merged;
}
