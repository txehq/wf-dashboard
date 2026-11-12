import type { LiveEngine } from '../db/schema.js';

// Deleted variants and workflows keep a row only to show their name (Contracts 24.3, 24.5): "<name> (deleted)"
export const DELETED_SUFFIX = ' (deleted)';

export const displayName = (row: { name: string; deletedAt: Date | null }) =>
  row.deletedAt === null ? row.name : `${row.name}${DELETED_SUFFIX}`;

// Engine names used in text ("from Claude Code draft ...", Contracts 28.4)
export const engineNames: Record<LiveEngine, string> = { codex: 'Codex', claude: 'Claude Code' };
