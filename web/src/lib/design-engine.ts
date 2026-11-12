import { useSyncExternalStore } from 'react';
import type { DraftEngine } from '@/lib/drafts-api';

// The engine for "Generate workflow", "Generate variant" and "Optimize" (Contracts 28.4): shared by all three and kept
// in localStorage, defaulting to the last choice; Codex when nothing was ever chosen
const KEY = 'wfd.design.engine';
const listeners = new Set<() => void>();

function read(): DraftEngine {
  return localStorage.getItem(KEY) === 'claude' ? 'claude' : 'codex';
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

export function useDesignEngine(): [DraftEngine, (next: DraftEngine) => void] {
  const engine = useSyncExternalStore(subscribe, read);
  const set = (next: DraftEngine) => {
    localStorage.setItem(KEY, next);
    for (const listener of listeners) listener();
  };
  return [engine, set];
}
