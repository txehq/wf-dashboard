import os from 'node:os';
import path from 'node:path';

// SBPL string literal for sandbox-exec
const literal = (value: string) => JSON.stringify(value);
const subpath = (dir: string) => `(subpath ${literal(dir)})`;

export interface AnalysisSandboxRoots {
  // data/analyses/<id>: input/ read-only, output/ writable
  analysisDir: string;
  // The engine's own config dir (CLAUDE_CONFIG_DIR or CODEX_HOME), where it writes sessions and caches
  engineHome: string;
  // Dashboard repo and data dir: no reads or writes except the analysis dir
  repoRoot: string;
  dataDir: string;
  home?: string;
}

// Profile of the analysis engine process (Contracts 15.2): read-only input/, write-only output/.
// Read limits block only file-read-data (contents and listings); the user's ~/.claude and ~/.codex (other sessions, credentials) are unreadable too.
// Later rules in SBPL take precedence
export function analysisSandboxProfile(roots: AnalysisSandboxRoots): string {
  const home = roots.home ?? os.homedir();
  const output = path.join(roots.analysisDir, 'output');
  return [
    '(version 1)(allow default)',
    `(deny file-write* ${subpath(home)} ${subpath(roots.repoRoot)} ${subpath(roots.dataDir)})`,
    `(allow file-write* ${[output, roots.engineHome, path.join(home, '.cache'), path.join(home, 'Library/Caches')].map(subpath).join(' ')})`,
    `(deny file-read-data ${[roots.repoRoot, roots.dataDir, path.join(home, '.claude'), path.join(home, '.codex')].map(subpath).join(' ')} (literal ${literal(path.join(home, '.claude.json'))}))`,
    `(allow file-read-data ${subpath(roots.analysisDir)} ${subpath(roots.engineHome)})`,
    `(deny file-write* ${subpath(path.join(roots.analysisDir, 'input'))})`,
  ].join('');
}
