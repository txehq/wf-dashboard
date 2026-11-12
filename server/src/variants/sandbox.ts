import os from 'node:os';
import path from 'node:path';
import { config } from '../config.js';

// A string literal in sandbox-exec SBPL
const literal = (value: string) => JSON.stringify(value);

// Profile for wf commands: under the real home only the variant directory is writable; a process writing elsewhere gets SIGKILL
export function wfSandboxProfile(variantDir: string): string {
  return (
    '(version 1)(allow default)' +
    `(deny file-write* (subpath ${literal(os.homedir())}) (with send-signal SIGKILL))` +
    `(allow file-write* (subpath ${literal(variantDir)}))`
  );
}

export interface SandboxRoots {
  // The dashboard repo (source, hidden tests and rubrics in tasks/, .spikes/, .work/)
  repoRoot: string;
  // The data directory (db.sqlite, every run and variant); reading is denied as a whole even when WFD_DATA_DIR is outside the repo
  dataDir: string;
  runsDir: string;
  variantsDir: string;
  // <vault>/Project Magi Eval/Features
  featuresDir: string;
  home: string;
}

const defaultRoots = (): SandboxRoots => ({
  repoRoot: config.repoRoot,
  dataDir: config.dataDir,
  runsDir: config.runsDir,
  variantsDir: config.variantsDir,
  featuresDir: path.join(config.vaultDir, `Project ${config.evalProduct}`, 'Features'),
  home: os.homedir(),
});

// Cache and state directories under home that tools write (npm, Playwright browsers, gh, mcp-remote login, ctx)
const homeCaches = [
  '.npm',
  '.cache',
  '.config',
  '.mcp-auth',
  '.ctx',
  '.local/share',
  '.local/state',
  'Library/Caches',
  'Library/pnpm',
];

// The real Claude config, wf state, Codex config and ~/.local/bin: a process writing there gets SIGKILL
const protectedDirs = [
  '.claude',
  'Library/Application Support/wf',
  'Library/Caches/wf',
  '.codex',
  '.local/bin',
];

// Profile of design and analysis-optimisation Claude Code sessions (Contracts 22.2): write - within home, the dashboard repo and the
// data directory only the working directory (holding the session's claude-config/ and .claude/skills/), the npm cache and the
// mcp-remote login (~/.mcp-auth, written back on token refresh, Contracts 28.1);
// read - within the dashboard repo and data directory only the working directory and files
// (the hooks settings files claude reads, the claude program itself when it is in the repo). Network as usual
export function sessionSandboxProfile(
  workDir: string,
  files: string[],
  roots: Pick<SandboxRoots, 'repoRoot' | 'dataDir' | 'home'> = defaultRoots(),
): string {
  const subpath = (dir: string) => `(subpath ${literal(dir)})`;
  return [
    '(version 1)(allow default)',
    `(deny file-write* ${[roots.home, roots.repoRoot, roots.dataDir].map(subpath).join(' ')})`,
    `(allow file-write* ${subpath(workDir)} ${subpath(path.join(roots.home, '.npm'))} ${subpath(path.join(roots.home, '.mcp-auth'))})`,
    ...protectedDirs.map(
      (dir) =>
        `(deny file-write* ${subpath(path.join(roots.home, dir))} (with send-signal SIGKILL))`,
    ),
    `(deny file-write* (literal ${literal(path.join(roots.home, '.claude.json'))}) (with send-signal SIGKILL))`,
    `(deny file-read-data ${subpath(roots.repoRoot)} ${subpath(roots.dataDir)})`,
    `(allow file-read-data ${subpath(workDir)}${files.map((f) => ` (literal ${literal(f)})`).join('')})`,
  ].join('');
}

// Profile of the claude process (Contracts 7.3), inherited by claude, hook, MCP and tool children:
// write - within home, the dashboard repo, the data directory and the vault's Project <product> directory only this run's directory,
// this variant's directory, this run's feature directory and tool caches (also denied when they are not under home);
// read - the whole dashboard repo and data directory are unreadable except this run's and this variant's directories (other runs'
// sessions inside are denied again), and other runs' feature directories are unreadable.
// The read limit only blocks file-read-data (file contents and directory listings); path lookup and stat work, so parents do not block own directories.
// Later SBPL rules take precedence
export function claudeSandboxProfile(
  runId: string,
  variantId: string,
  roots: SandboxRoots = defaultRoots(),
): string {
  const variantDir = path.join(roots.variantsDir, variantId);
  const projectsDir = path.join(variantDir, 'home', 'claude', 'projects');
  const subpath = (dir: string) => `(subpath ${literal(dir)})`;
  return runProfile(runId, roots, {
    write: [variantDir],
    read: [
      `(allow file-read-data ${subpath(variantDir)})`,
      `(deny file-read-data ${subpath(projectsDir)})`,
      `(allow file-read-data ${subpath(path.join(projectsDir, runId))})`,
    ],
  });
}

// An interactive process in the isolated environment using the local machine's config (Contracts 29.2): like claudeSandboxProfile, with the
// variant directory replaced by .claude and .claude.json under claudeHome (Claude Code reads credentials, writes sessions and state) and the
// state directories written by wf as called from the user's hooks and wf-installed skills, all readable and writable: the user's own config works
export function localClaudeSandboxProfile(
  runId: string,
  claudeHome: string,
  roots: SandboxRoots = defaultRoots(),
): string {
  const subpath = (dir: string) => `(subpath ${literal(dir)})`;
  const owned = [
    path.join(claudeHome, '.claude'),
    ...wfStateDirs.map((d) => path.join(claudeHome, d)),
  ];
  const state = path.join(claudeHome, '.claude.json');
  // .claude.json is written to a temporary file beside it and renamed; its backups sit next to it
  const stateFiles = `(literal ${literal(state)}) (regex #"^${escapeRegex(state)}\\.")`;
  return runProfile(runId, roots, {
    write: [],
    read: [`(allow file-read-data file-write* ${owned.map(subpath).join(' ')} ${stateFiles})`],
  });
}

// wf state directories (two of protectedDirs)
const wfStateDirs = ['Library/Application Support/wf', 'Library/Caches/wf'];

const escapeRegex = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Profile of a run's (or interactive item's) claude process; config holds its Claude config's extra writable directories and the final read/write rules
function runProfile(
  runId: string,
  roots: SandboxRoots,
  config: { write: string[]; read: string[] },
): string {
  const runDir = path.join(roots.runsDir, runId);
  const featureDir = path.join(roots.featuresDir, runId);
  const subpath = (dir: string) => `(subpath ${literal(dir)})`;
  return [
    '(version 1)(allow default)',
    `(deny file-write* ${[roots.home, roots.repoRoot, roots.dataDir, path.dirname(roots.featuresDir)].map(subpath).join(' ')})`,
    `(allow file-write* ${[runDir, ...config.write, featureDir, ...homeCaches.map((d) => path.join(roots.home, d))].map(subpath).join(' ')})`,
    ...protectedDirs.map(
      (dir) =>
        `(deny file-write* ${subpath(path.join(roots.home, dir))} (with send-signal SIGKILL))`,
    ),
    `(deny file-write* (literal ${literal(path.join(roots.home, '.claude.json'))}) (with send-signal SIGKILL))`,
    `(deny file-read-data ${[roots.repoRoot, roots.dataDir, roots.runsDir, roots.variantsDir, roots.featuresDir].map(subpath).join(' ')})`,
    `(allow file-read-data ${subpath(runDir)} ${subpath(featureDir)})`,
    ...config.read,
  ].join('');
}
