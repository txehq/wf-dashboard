import { useSyncExternalStore } from 'react';

// variant 页面中 .md 文件的"编辑 / 预览 / 并排"（Contracts 21.2）：默认预览，选择记在 localStorage
export type MdView = 'edit' | 'preview' | 'split';

const KEY = 'wfd.variant.mdView';
const listeners = new Set<() => void>();

function read(): MdView {
  const stored = localStorage.getItem(KEY);
  return stored === 'edit' || stored === 'split' ? stored : 'preview';
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

export function useMdView(): [MdView, (next: MdView) => void] {
  const view = useSyncExternalStore(subscribe, read);
  const set = (next: MdView) => {
    localStorage.setItem(KEY, next);
    for (const listener of listeners) listener();
  };
  return [view, set];
}

export const isMarkdown = (path: string) => path.toLowerCase().endsWith('.md');
