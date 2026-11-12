import { useSyncExternalStore } from 'react';
import type { SessionEngine } from '@/lib/sessions-api';

// The Sessions page view "Claude Code | Codex" (Contracts 25.1): the choice is kept in localStorage, Claude Code
// by default; shared by the Sessions page and the "Import local sessions" picker
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
