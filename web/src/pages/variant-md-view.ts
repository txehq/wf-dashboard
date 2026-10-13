import { useSyncExternalStore } from 'react';

// variant 编辑区的显示（Contracts 21.2）：.md 文件为编辑、预览、并排、对比，其他文件为编辑、对比。
// 默认预览，选择记在 localStorage
export type WorkspaceView = 'edit' | 'preview' | 'split' | 'diff';
// 编辑器一侧的显示：.md 文件的编辑、预览、并排
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

// 当前文件下实际的显示：预览与并排只对 .md 文件
export function effectiveView(stored: WorkspaceView, path: string | null): WorkspaceView {
  if (stored === 'diff') return 'diff';
  return path !== null && isMarkdown(path) ? stored : 'edit';
}

export const viewLabels: Record<WorkspaceView, string> = {
  edit: '编辑',
  preview: '预览',
  split: '并排',
  diff: '对比',
};

export function viewsOf(path: string | null): WorkspaceView[] {
  return path !== null && isMarkdown(path)
    ? ['edit', 'preview', 'split', 'diff']
    : ['edit', 'diff'];
}
