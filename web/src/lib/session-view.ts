import { useSyncExternalStore } from 'react';
import type { SessionEngine } from '@/lib/sessions-api';

// Sessions 页面的视图"Claude Code | Codex"（Contracts 25.1）：选择记在 localStorage，默认 Claude Code；
// Sessions 页面与"导入本机 session"选择框共用
const KEY = 'wfd.sessions.engine';
const listeners = new Set<() => void>();

function read(): SessionEngine {
  return localStorage.getItem(KEY) === 'codex' ? 'codex' : 'claude';
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

export function useSessionEngine(): [SessionEngine, (next: SessionEngine) => void] {
  const engine = useSyncExternalStore(subscribe, read);
  const set = (next: SessionEngine) => {
    localStorage.setItem(KEY, next);
    for (const listener of listeners) listener();
  };
  return [engine, set];
}
