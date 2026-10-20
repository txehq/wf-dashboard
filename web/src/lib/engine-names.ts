import type { DraftEngine } from '@/lib/drafts-api';

// 引擎在文字中的名字（"来自 Claude Code 草稿 …"，Contracts 28.4）
export const engineNames: Record<DraftEngine, string> = { codex: 'Codex', claude: 'Claude Code' };
