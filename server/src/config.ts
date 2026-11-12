import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// src/ and dist/ both sit under server/; two levels up is the repo root (in a release package, the package root)
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
// WFD_DATA_DIR (relative to the repo root or absolute) points at another data directory; tests use their own
const dataDir = path.resolve(repoRoot, process.env.WFD_DATA_DIR ?? 'data');

// A release package (Contracts 39.2) carries release.json at its root (WF Dashboard.app/Contents/Resources/server/); a
// git checkout has none. The app starts the server with the install root (the directory holding data/, logs/ and
// updates/) as WFD_INSTALL_ROOT and its own process id as WFD_APP_PID
const ReleaseFile = z.object({ version: z.string().min(1), commit: z.string().min(1) });
export const RELEASE_FILE = 'release.json';

function readInstall() {
  const file = path.join(repoRoot, RELEASE_FILE);
  if (!fs.existsSync(file)) return null;
  const release = ReleaseFile.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  const root = process.env.WFD_INSTALL_ROOT ?? '';
  const appPid = process.env.WFD_APP_PID ?? '';
  if (root === '' || appPid === '') {
    throw new Error(
      `${file} marks this as the server of WF Dashboard.app, but WFD_INSTALL_ROOT or WFD_APP_PID is not set; open WF Dashboard.app to start it`,
    );
  }
  const packageDir = path.resolve(repoRoot);
  const appPath = path.resolve(packageDir, '../../..');
  if (path.extname(appPath) !== '.app') {
    throw new Error(`The release package ${packageDir} is not inside an app's Contents/Resources/`);
  }
  return {
    ...release,
    root: path.resolve(root),
    packageDir,
    appPath,
    appPid: z.coerce.number().int().positive().parse(appPid),
  };
}

export const install = readInstall();
export type Install = NonNullable<typeof install>;

// Obsidian vault location (Contracts section 30): same as txe-workflow's wf obsidian; MAGI_VAULT when non-empty
// (~ expanded, made absolute), otherwise txe-workflow's default
export const DEFAULT_VAULT = '~/Projects/Obsidian/TXE';
export type VaultSource = 'MAGI_VAULT' | 'default';

export function resolveVault(env: NodeJS.ProcessEnv): { dir: string; source: VaultSource } {
  const value = env.MAGI_VAULT ?? '';
  const source: VaultSource = value === '' ? 'default' : 'MAGI_VAULT';
  const raw = value === '' ? DEFAULT_VAULT : value;
  const expanded =
    raw === '~' || raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(1)) : raw;
  return { dir: path.resolve(expanded), source };
}

const vault = resolveVault(process.env);

// Default wait after SIGINT for "Stop process" (Contracts 14.3)
export const LIVE_STOP_GRACE_MS = 10_000;

export const config = {
  repoRoot,
  host: '127.0.0.1',
  // Parallel worktrees use WFD_PORT to avoid clashing
  port: z.coerce.number().int().min(1).max(65535).default(7317).parse(process.env.WFD_PORT),
  dataDir,
  // WFD_DB_PATH points at another database file
  dbPath: process.env.WFD_DB_PATH ?? path.join(dataDir, 'db.sqlite'),
  variantsDir: path.join(dataDir, 'variants'),
  runsDir: path.join(dataDir, 'runs'),
  // Interactive session directories (hooks.json, pty.log, isolated workspace)
  liveDir: path.join(dataDir, 'live'),
  // What the web VS Code of earlier versions kept (Contracts section 32), deleted at startup
  oldVscodeDir: path.join(dataDir, 'vscode'),
  // Playwright browsers installed for grading
  playwrightBrowsersDir: path.join(dataDir, 'playwright-browsers'),
  // Task definitions are written by the page and by Linear imports: an installed package keeps them in data/tasks/
  // (seeded from the package's tasks/ at startup) so they survive updates, which replace the package
  tasksDir: install === null ? path.join(repoRoot, 'tasks') : path.join(dataDir, 'tasks'),
  // The tasks shipped with the code
  bundledTasksDir: path.join(repoRoot, 'tasks'),
  // Where the Sessions page's source directories live; tests point WFD_CLAUDE_PROJECTS at their own directory
  claudeProjectsDir: path.resolve(
    process.env.WFD_CLAUDE_PROJECTS ?? path.join(os.homedir(), '.claude/projects'),
  ),
  // Local Codex CODEX_HOME (Contracts 25.1): its sessions/ and archived_sessions/ hold the local-config Codex sessions;
  // tests point WFD_CODEX_HOME at their own directory and never touch the user's ~/.codex
  codexHome: path.resolve(process.env.WFD_CODEX_HOME ?? path.join(os.homedir(), '.codex')),
  // The evaluated workflow repo; baseline variants are exported from its commits; other machines set WFD_TXE_WORKFLOW
  txeWorkflowRepo: path.resolve(
    process.env.WFD_TXE_WORKFLOW ?? path.join(os.homedir(), 'Project/txe/txe-workflow'),
  ),
  // The wf-history MCP starts the real ctx directly
  ctxBin: path.join(os.homedir(), '.local/bin/ctx'),
  migrationsDir: fileURLToPath(new URL('../drizzle', import.meta.url)),
  // Defaults such as run concurrency; PUT /api/settings saves changes in the database
  runConcurrency: 3,
  // Default repeats of each variant on each task
  defaultRepeats: 3,
  // Maximum simulated user replies in one run
  maxUserTurns: 80,
  // Source of gateway auth and model aliases
  claudeSettingsPath: path.join(os.homedir(), '.claude/settings.json'),
  // Login credentials for codex exec in skills, copied into the variant's CODEX_HOME before a run
  codexAuthPath: path.join(os.homedir(), '.codex/auth.json'),
  // codex exec model and provider config (e.g. via gateway); its model config is written into the variant's CODEX_HOME before a run
  codexConfigPath: path.join(os.homedir(), '.codex/config.toml'),
  // Environment check working directory: the Codex check prepares config under its codex-home, then runs codex exec
  environmentDir: path.join(dataDir, 'environment'),
  // Draft directories for workflows or variants generated with Codex (Contracts 17.2)
  workflowDraftsDir: path.join(dataDir, 'workflow-drafts'),
  // Command for Codex sessions in Live
  codexBin: 'codex',
  // Command for Claude Code sessions in Live
  claudeBin: 'claude',
  // Auto stop (Contracts 14.3): when there has been no /api/events SSE connection and no PTY WebSocket connection for this
  // long, stop all running interactive processes
  liveAutoStopMs: 120_000,
  // "Stop process": SIGINT first, SIGTERM if still running after this long
  liveStopGraceMs: LIVE_STOP_GRACE_MS,
  // SSH hosts (Contracts 31.1): always connect with this machine's ssh, which reads ~/.ssh/config; the Host list is read from it
  sshHostsFile: path.join(os.homedir(), '.ssh', 'config'),
  // ControlMaster socket directory: macOS socket paths are limited to 104 bytes, so keep it short
  sshControlDir: path.resolve(
    process.env.WFD_SSH_CONTROL_DIR ?? path.join(os.homedir(), '.wf-dashboard', 'ssh'),
  ),
  // Reconnect interval after losing a remote connection
  sshReconnectMs: 5000,
  // Local copies of synced remote sessions (Contracts 31.6): data/remote/<hostId>/<remote path>
  remoteDir: path.join(dataDir, 'remote'),
  // Orca (Contracts section 35): command the dashboard uses to read and write Orca orchestration and create identity
  // terminals for Live items; pollMs is how often Orca's runs, tasks and workers are read while a page is connected (Contracts 35.3)
  orca: { bin: 'orca', pollMs: 5000 },
  // Magi Agent (Contracts section 23): the main repo is the running dashboard's directory (deploy merges into its main,
  // MAGI.md is read from it); the worktree sits in the main repo's parent directory. An installed package has no git
  // repository: the agent works in the package's own sources, read-only (Contracts 39.5)
  magiRepo: path.resolve(repoRoot),
  magiWorktree:
    install === null
      ? path.join(path.dirname(path.resolve(repoRoot)), 'wf-dashboard-magi-agent')
      : path.resolve(repoRoot),
  // Check run in the worktree at deploy step 3 (Contracts 23.5)
  magiCheck: ['pnpm', 'check'],
  // Command of the Linear MCP connection: null is mcp-remote (external/linear.ts); the Linear stats test swaps in the
  // stand-in that replays recorded Linear responses via WFD_LINEAR_MCP (JSON array)
  linearMcp:
    process.env.WFD_LINEAR_MCP === undefined
      ? null
      : z.array(z.string().min(1)).min(1).parse(JSON.parse(process.env.WFD_LINEAR_MCP)),
  // Linear stats (Contracts section 37): the team counted, and the sync at startup and every 30 minutes (37.2)
  teamStatsTeam: 'TXE',
  teamSyncIntervalMs: 30 * 60_000,
  // Obsidian vault and product written by evaluation runs (wf obsidian writes to <vault>/Project <product>/);
  // read once at startup; tests set MAGI_VAULT to a directory under .work/
  vaultDir: vault.dir,
  vaultSource: vault.source,
  evalProduct: 'Magi Eval',
  sseHeartbeatMs: 15_000,
} as const;
