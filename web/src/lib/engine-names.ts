import type { DraftEngine } from '@/lib/drafts-api';

// Engine names in text ("From Claude Code draft …", Contracts 28.4)
export const engineNames: Record<DraftEngine, string> = { codex: 'Codex', claude: 'Claude Code' };
