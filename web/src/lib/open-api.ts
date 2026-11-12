import { requestJson } from '@/lib/http';

// Targets of "Open in Finder" (Contracts 16.7, 18.2): the server resolves known directories; no arbitrary paths are sent
export type OpenTarget =
  | { kind: 'variant'; id: string }
  | { kind: 'live-cwd'; id: string }
  | { kind: 'live-config'; id: string }
  | { kind: 'session-cwd'; id: string };

export const openInFinder = (target: OpenTarget) => requestJson('POST', '/api/open', { target });
