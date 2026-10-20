import { useSyncExternalStore } from 'react';
import type { DraftEngine } from '@/lib/drafts-api';

// "生成 workflow""生成 variant""优化"的引擎（Contracts 28.4）：三处共用，选择记在 localStorage，
// 下次默认上次选的；从来没有选过时为 Codex
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
