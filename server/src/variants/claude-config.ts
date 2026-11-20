import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../config.js';
import { claudeSettingsEnv } from '../llm/client.js';

// Shared writers for every Claude Code config directory the dashboard owns (CLAUDE_CONFIG_DIR): the variant's isolated
// config (7.10, 14.2) and the design and analysis-optimisation sessions' own claude-config/ (Contracts 22.2)

const IsolatedSettings = z.looseObject({
  env: z.record(z.string(), z.unknown()).optional(),
  claudeMdExcludes: z.array(z.string()).optional(),
});
export type IsolatedSettings = z.infer<typeof IsolatedSettings>;

const ClaudeState = z.looseObject({
  hasCompletedOnboarding: z.boolean().optional(),
  // Per-directory state; trust is recorded in projects[<dir>].hasTrustDialogAccepted (measured in Reports/W39: an ancestor's trust covers subdirectories)
  projects: z
    .record(z.string(), z.looseObject({ hasTrustDialogAccepted: z.boolean().optional() }))
    .optional(),
});

function writeAtomic(file: string, value: unknown) {
  // Write a temporary file, then rename it: processes starting concurrently never read a half-written file
  const tmp = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Merges the settings source's env block (auth and gateway model aliases) into <claudeDir>/settings.json, keeping other
// fields; returns the merged keys
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

// With cwd under $HOME, the real ~/.claude/CLAUDE.md would be read as an ancestor directory's file
export function realClaudeMdExcludes(home = os.homedir()): string[] {
  return [path.join(home, '.claude/CLAUDE.md'), path.join(home, '.claude/rules/**')];
}

// Claude Code's first-run onboarding (theme, safety notice) appears only on interactive start and is stored in
// <CLAUDE_CONFIG_DIR>/.claude.json; the dashboard owns the directory and marks onboarding done (Contracts 14.2). No change when already written
export function markOnboardingDone(claudeDir: string) {
  const file = path.join(claudeDir, '.claude.json');
  const state = fs.existsSync(file)
    ? ClaudeState.parse(JSON.parse(fs.readFileSync(file, 'utf8')))
    : {};
  if (state.hasCompletedOnboarding === true) return;
  writeAtomic(file, { ...state, hasCompletedOnboarding: true });
}

// Before start and resume, marks cwd as trusted (Contracts 14.2) so Claude Code does not ask; no change when already trusted.
// When cwd goes through a symlink, both the given and the real path (realCwd) are recorded
export function trustDirectory(claudeDir: string, cwd: string, realCwd: string) {
  const file = path.join(claudeDir, '.claude.json');
  const state = ClaudeState.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  const dirs = [...new Set([path.resolve(cwd), realCwd])];
  const projects = { ...state.projects };
  if (dirs.every((d) => projects[d]?.hasTrustDialogAccepted === true)) return;
  for (const d of dirs) projects[d] = { ...projects[d], hasTrustDialogAccepted: true };
  writeAtomic(file, { ...state, projects });
}

// When the parent is Claude Code or Orca these variables would override the child's isolation; variables of the Orca
// terminal running the dashboard (ORCA_*) never reach the child, Live sets a Live item's Orca identity itself (Contracts 35.2).
// The agent's wf obsidian writes the vault at MAGI_VAULT (Contracts section 30): always set to the location the dashboard
// read, so it stays the same when HOME points elsewhere
export function isolatedBaseEnv(): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined &&
          !entry[0].startsWith('CLAUDE') &&
          !entry[0].startsWith('ANTHROPIC') &&
          !entry[0].startsWith('ORCA_'),
      ),
    ),
    MAGI_VAULT: config.vaultDir,
  };
}

// Config directory of design and analysis-optimisation sessions (Contracts 22.2), rewritten before every start and resume:
// credentials and model config (auth may have changed), no real CLAUDE.md, onboarding done, working directory trusted, and
// the MCP servers of the variant's src/mcp.json (28.1, user-scope mcpServers, replaced whole). No model is written: the
// local machine's Claude Code default from the settings source env applies
export function writeSessionClaudeConfig(
  claudeDir: string,
  cwd: string,
  settingsPath: string | undefined,
  mcpServers: Record<string, unknown>,
): string[] {
  fs.mkdirSync(claudeDir, { recursive: true });
  const file = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(file)) writeAtomic(file, {});
  const merged = writeIsolatedSettings(claudeDir, settingsPath, (settings) => {
    settings.claudeMdExcludes = realClaudeMdExcludes();
  });
  markOnboardingDone(claudeDir);
  // A design or optimize session's working directory is the dashboard's own, under its data directory
  trustDirectory(claudeDir, cwd, fs.realpathSync(cwd));
  const state = path.join(claudeDir, '.claude.json');
  writeAtomic(state, {
    ...ClaudeState.parse(JSON.parse(fs.readFileSync(state, 'utf8'))),
    mcpServers,
  });
  return merged;
}
