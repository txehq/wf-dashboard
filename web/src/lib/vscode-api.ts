import { requestJson } from '@/lib/http';

// Open a Live item's working directory in the user's VS Code (Contracts section 32)
export const openVscode = (liveId: string) => requestJson('POST', '/api/vscode/open', { liveId });

// Open the working directory of a session on the Orca page, which needs no Live item (Contracts 40.2)
export const openVscodeForOrcaNode = (orcaNodeId: string) =>
  requestJson('POST', '/api/vscode/open', { orcaNodeId });
