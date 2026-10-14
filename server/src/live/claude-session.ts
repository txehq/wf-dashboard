import path from 'node:path';

// 设计与分析优化的 Claude Code 会话在工作目录中的两个目录（Contracts 22.2）：dashboard 所有的配置目录
// （CLAUDE_CONFIG_DIR），与项目范围的 skill（npx skills add -a claude-code 装到这里，Claude Code 从 cwd 的
// .claude/skills 加载）
export function claudeSessionDirsOf(cwd: string) {
  return {
    claudeDir: path.join(cwd, 'claude-config'),
    claudeSkills: path.join(cwd, '.claude', 'skills'),
  };
}
