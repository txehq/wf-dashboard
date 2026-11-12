import { requestJson } from '@/lib/http';

// Open a Live item's working directory in the user's VS Code (Contracts section 32)
export const openVscode = (liveId: string) => requestJson('POST', '/api/vscode/open', { liveId });
