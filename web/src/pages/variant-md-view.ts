import { useSyncExternalStore } from 'react';

// Variant editor views (Contracts 21.2): .md files have edit, preview, side by side and diff; other
// files have edit and diff. Defaults to preview; the choice is kept in localStorage
export type WorkspaceView = 'edit' | 'preview' | 'split' | 'diff';
// Views on the editor side: edit, preview and side by side for .md files
export type MdView = Exclude<WorkspaceView, 'diff'>;

const KEY = 'wfd.variant.view';
const listeners = new Set<() => void>();
const views: readonly string[] = ['edit', 'preview', 'split', 'diff'];
const isView = (value: string | null): value is WorkspaceView =>
  value !== null && views.includes(value);

function read(): WorkspaceView {
  const stored = localStorage.getItem(KEY);
  return isView(stored) ? stored : 'preview';
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

export function useWorkspaceView(): [WorkspaceView, (next: WorkspaceView) => void] {
  const view = useSyncExternalStore(subscribe, read);
  const set = (next: WorkspaceView) => {
    localStorage.setItem(KEY, next);
    for (const listener of listeners) listener();
  };
  return [view, set];
}

export const isMarkdown = (path: string) => path.toLowerCase().endsWith('.md');

// The view actually shown for the current file: preview and side by side are .md only
export function effectiveView(stored: WorkspaceView, path: string | null): WorkspaceView {
  if (stored === 'diff') return 'diff';
  return path !== null && isMarkdown(path) ? stored : 'edit';
}

export const viewLabels: Record<WorkspaceView, string> = {
  edit: 'Edit',
  preview: 'Preview',
  split: 'Side by side',
  diff: 'Diff',
};

export function viewsOf(path: string | null): WorkspaceView[] {
  return path !== null && isMarkdown(path)
    ? ['edit', 'preview', 'split', 'diff']
    : ['edit', 'diff'];
}
