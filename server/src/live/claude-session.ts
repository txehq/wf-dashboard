import path from 'node:path';

// Two directories in the cwd of a design or analysis-optimization Claude Code session (Contracts 22.2): the dashboard-owned config
// directory (CLAUDE_CONFIG_DIR), and project-scoped skills (installed here by npx skills add -a claude-code; Claude Code loads them from
// the cwd's .claude/skills)
export function claudeSessionDirsOf(cwd: string) {
  return {
    claudeDir: path.join(cwd, 'claude-config'),
    claudeSkills: path.join(cwd, '.claude', 'skills'),
  };
}
