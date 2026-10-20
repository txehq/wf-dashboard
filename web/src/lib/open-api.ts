import { requestJson } from '@/lib/http';

// "在访达中打开"的目标（Contracts 16.7、18.2）：服务端解析出已知的目录，不传任意路径
export type OpenTarget =
  | { kind: 'variant'; id: string }
  | { kind: 'live-cwd'; id: string }
  | { kind: 'live-config'; id: string }
  | { kind: 'session-cwd'; id: string };

export const openInFinder = (target: OpenTarget) => requestJson('POST', '/api/open', { target });
