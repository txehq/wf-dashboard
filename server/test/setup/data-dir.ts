import path from 'node:path';

// Each test process's data directory: .work/test-data/<pid>/ in the repo, in effect before any test module reads config.
// config defaults to data/ at the repo root, the user instance's data directory, which tests must not write to
const dir = path.resolve(import.meta.dirname, '../../../.work/test-data', String(process.pid));
process.env.WFD_DATA_DIR = dir;
process.env.WFD_DB_PATH = path.join(dir, 'db.sqlite');
// This machine's Codex CODEX_HOME (Contracts 25.1): an empty directory in tests; the user's ~/.codex is never read or written
process.env.WFD_CODEX_HOME = path.join(dir, 'codex-home');
// The local config's Claude Code projects directory (Contracts 25.4): a directory here in tests; the user's ~/.claude is never read or written
process.env.WFD_CLAUDE_PROJECTS = path.join(dir, 'claude-projects');
// Obsidian vault (Contracts section 30): tests do not read the user's MAGI_VAULT
process.env.MAGI_VAULT = path.join(dir, 'vault');
