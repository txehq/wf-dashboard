import { useSyncExternalStore } from 'react';
import type { ViewType } from 'react-diff-view';

// The "Unified / Side by side" choice is kept in localStorage and shared by all diffs (Contracts 21.3)
const KEY = 'wfd.diff.view';
const listeners = new Set<() => void>();

function read(): ViewType {
  return localStorage.getItem(KEY) === 'split' ? 'split' : 'unified';
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

export function useDiffViewType(): [ViewType, (next: ViewType) => void] {
  const viewType = useSyncExternalStore(subscribe, read);
  const set = (next: ViewType) => {
    localStorage.setItem(KEY, next);
    for (const listener of listeners) listener();
  };
  return [viewType, set];
}
