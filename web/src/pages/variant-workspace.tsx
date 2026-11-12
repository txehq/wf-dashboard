import { Editor } from '@monaco-editor/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  FileText,
  FolderPlus,
  PanelBottom,
  PanelLeft,
  Pencil,
  Save,
  Trash2,
} from 'lucide-react';
import {
  type PointerEvent,
  type RefObject,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import type { ViewType } from 'react-diff-view';
import { useSearchParams } from 'react-router';
import {
  type DiffFile,
  DiffView,
  DiffViewTypeToggle,
  parseUnifiedDiff,
  useDiffViewType,
} from '@/components/diff';
import {
  FullscreenArea,
  FullscreenButton,
  type Fullscreen,
  useFullscreenLayout,
} from '@/components/fullscreen';
import { Markdown } from '@/components/markdown';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import { languageOf } from '@/lib/language';
import { cn } from '@/lib/utils';
import {
  effectiveView,
  type MdView,
  useWorkspaceView,
  viewLabels,
  viewsOf,
} from '@/pages/variant-md-view';
import {
  buildLogQuery,
  diffQuery,
  type FileDiff,
  fileQuery,
  filesQuery,
  importedLabel,
  isImported,
  request,
  type SkillFile,
  type Variant,
} from '@/pages/variants-api';
import { QueryError } from '@/pages/variants-error';
import { monaco, useMonacoTheme } from '@/pages/variants-monaco';

type MonacoEditor = Parameters<NonNullable<Parameters<typeof Editor>[0]['onMount']>>[0];

interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
}

// Build a directory tree from paths like skills/a/b.md; the roots are the skills under skills/
function buildTree(files: SkillFile[]): TreeNode[] {
  const root: TreeNode = { name: '', path: 'skills', children: [] };
  for (const file of files) {
    let node = root;
    for (const segment of file.path.split('/').slice(1)) {
      let child = node.children.find((c) => c.name === segment);
      if (child === undefined) {
        child = { name: segment, path: `${node.path}/${segment}`, children: [] };
        node.children.push(child);
      }
      node = child;
    }
  }
  return root.children;
}

// Rename and delete of skill directories (first level under skills/, Contracts 16.4)
interface SkillActions {
  onRename: (name: string) => void;
  onDelete: (name: string) => void;
}

function TreeItem({
  node,
  depth,
  selected,
  onSelect,
  actions,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
  // Only for skill directories (depth 0) of an editable variant
  actions?: SkillActions | undefined;
}) {
  const [open, setOpen] = useState(selected?.startsWith(`${node.path}/`) === true);
  const indent = { paddingLeft: `${String(depth * 12 + 8)}px` };
  if (node.children.length === 0) {
    return (
      <button
        type="button"
        style={indent}
        title={node.path}
        className={cn(
          'flex w-full items-center gap-1 rounded py-0.5 pr-2 text-left hover:bg-accent',
          selected === node.path && 'bg-accent font-medium',
        )}
        onClick={() => {
          onSelect(node.path);
        }}
      >
        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{node.name}</span>
      </button>
    );
  }
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <div>
      <div className="group flex items-center" style={indent}>
        <button
          type="button"
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-1 rounded py-0.5 pr-2 text-left hover:bg-accent"
          onClick={() => {
            setOpen(!open);
          }}
        >
          <Icon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{node.name}</span>
        </button>
        {actions !== undefined && (
          <span className="flex shrink-0 gap-0.5 pr-1 opacity-0 group-hover:opacity-100 focus-within:opacity-100">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Rename skill ${node.name}`}
              title="Rename skill directory"
              onClick={() => {
                actions.onRename(node.name);
              }}
            >
              <Pencil />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Delete skill ${node.name}`}
              title="Delete skill directory"
              onClick={() => {
                actions.onDelete(node.name);
              }}
            >
              <Trash2 />
            </Button>
          </span>
        )}
      </div>
      {open &&
        node.children.map((child) => (
          <TreeItem
            key={child.path}
            node={child}
            depth={depth + 1}
            selected={selected}
            onSelect={onSelect}
          />
        ))}
    </div>
  );
}

// State of the file being edited, shown in the workspace toolbar
export interface EditorStatus {
  dirty: boolean;
  saving: boolean;
  error: string | null;
}

const cleanStatus: EditorStatus = { dirty: false, saving: false, error: null };

// Side by side, the editor and preview scroll in proportion; a scroll caused by the other side does not echo
// back. The editor reports its scroll synchronously inside setScrollTop; the preview's scroll event arrives a
// frame later (much later on a busy machine) and is recognised by the position it was moved to
function useEditorPreviewSync(
  editor: MonacoEditor | null,
  preview: RefObject<HTMLDivElement | null>,
  active: boolean,
) {
  useEffect(() => {
    const target = preview.current;
    if (editor === null || target === null || !active) return;
    let movingEditor = false;
    let previewMovedTo: number | null = null;
    const fromEditor = editor.onDidScrollChange((event) => {
      if (!event.scrollTopChanged || movingEditor) return;
      const range = event.scrollHeight - editor.getLayoutInfo().height;
      const ratio = range <= 0 ? 0 : event.scrollTop / range;
      const from = target.scrollTop;
      target.scrollTop = ratio * (target.scrollHeight - target.clientHeight);
      // No scroll event fires when the position did not change
      previewMovedTo = target.scrollTop === from ? null : target.scrollTop;
    });
    const fromPreview = () => {
      const moved = target.scrollTop === previewMovedTo;
      previewMovedTo = null;
      if (moved) return;
      const range = target.scrollHeight - target.clientHeight;
      const ratio = range <= 0 ? 0 : target.scrollTop / range;
      movingEditor = true;
      editor.setScrollTop(ratio * (editor.getScrollHeight() - editor.getLayoutInfo().height));
      movingEditor = false;
    };
    target.addEventListener('scroll', fromPreview, { passive: true });
    return () => {
      fromEditor.dispose();
      target.removeEventListener('scroll', fromPreview);
    };
  }, [editor, preview, active]);
}

function FileEditor({
  variant,
  path,
  readOnly,
  view,
  saveRef,
  onStatus,
  onOpenFile,
}: {
  variant: Variant;
  path: string;
  readOnly: boolean;
  // Edit / preview / side by side for .md files; other files are always edit
  view: MdView;
  // Called by the toolbar's Save and by ⌘S
  saveRef: RefObject<() => void>;
  onStatus: (status: EditorStatus) => void;
  // Links in the preview that point to other files in the variant
  onOpenFile: (path: string) => void;
}) {
  const theme = useMonacoTheme();
  const queryClient = useQueryClient();
  const file = useQuery(fileQuery(variant.id, path));
  const [draft, setDraft] = useState<string | null>(null);
  const editorRef = useRef<MonacoEditor | null>(null);
  const [editor, setEditor] = useState<MonacoEditor | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  // The preview follows edits live; fast typing may let rendering lag a few characters
  const previewContent = useDeferredValue(draft ?? file.data?.content ?? '');
  useEditorPreviewSync(editor, previewRef, view === 'split');
  const dirty = draft !== null && draft !== file.data?.content;
  const save = useMutation({
    mutationFn: (content: string) =>
      request<Variant>('PUT', `/api/variants/${variant.id}/file`, { path, content }),
    onSuccess: async (_variant, content) => {
      queryClient.setQueryData(fileQuery(variant.id, path).queryKey, { path, content });
      setDraft(null);
      await queryClient.invalidateQueries({ queryKey: ['variants'] });
    },
  });
  const error = save.error?.message ?? null;
  useEffect(() => {
    onStatus({ dirty, saving: save.isPending, error });
  }, [dirty, save.isPending, error, onStatus]);
  useEffect(() => {
    saveRef.current = () => {
      if (!readOnly && draft !== null && draft !== file.data?.content) save.mutate(draft);
    };
  });
  // Re-layout at the new size after entering or leaving full screen; content, cursor and selection stay (same editor instance)
  useFullscreenLayout(() => {
    editorRef.current?.layout();
  });

  if (file.isPending) return <p className="p-4 text-sm text-muted-foreground">Loading…</p>;
  if (file.isError) {
    return (
      <QueryError
        className="p-4"
        error={file.error}
        retrying={file.isFetching}
        onRetry={() => void file.refetch()}
      />
    );
  }
  // In preview the editor is hidden, not unmounted: unsaved content, cursor and selection survive switching back
  return (
    <div className="flex min-h-0 min-w-0 flex-1" data-testid="file-view" data-view={view}>
      <div
        className={cn('min-h-0 min-w-0 flex-1', view === 'preview' && 'hidden')}
        data-testid="skill-editor"
      >
        <Editor
          key={path}
          defaultValue={file.data.content}
          language={languageOf(path)}
          theme={theme}
          options={{
            readOnly,
            minimap: { enabled: false },
            wordWrap: 'on',
            fontSize: 13,
            scrollBeyondLastLine: false,
            // Re-layout with the container when the tree is resized or a panel collapses
            automaticLayout: true,
          }}
          onChange={(value) => {
            setDraft(value ?? '');
          }}
          onMount={(mounted) => {
            editorRef.current = mounted;
            setEditor(mounted);
            mounted.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
              saveRef.current();
            });
          }}
        />
      </div>
      {view !== 'edit' && (
        <div
          ref={previewRef}
          className={cn('min-h-0 min-w-0 flex-1 overflow-auto', view === 'split' && 'border-l')}
          data-testid="md-preview"
        >
          <Markdown
            className="mx-auto max-w-[980px] px-8 py-6"
            content={previewContent}
            filePath={path}
            fileHref={(target) => `?file=${encodeURIComponent(target)}`}
            onOpenFile={onOpenFile}
          />
        </div>
      )}
    </div>
  );
}

const diffStatusLabel = { added: 'Added', removed: 'Removed', modified: 'Modified' } as const;

// Convert the server's unified diff for one file into the shared diff view's data; a new empty file has no hunks
function diffFileOf(f: FileDiff): DiffFile {
  return (
    parseUnifiedDiff(f.patch)[0] ?? {
      path: f.path,
      status: f.status,
      hunks: [],
      additions: 0,
      deletions: 0,
    }
  );
}

// Diff (Contracts 21.3): changed files on the left, their diffs on the right; clicking a file scrolls to it
function DiffPane({ variant, viewType }: { variant: Variant; viewType: ViewType }) {
  // A custom workflow's variant has no base (Contracts 18.6) and can only be compared with its source
  const hasBase = variant.baseCommit !== '';
  const [against, setAgainst] = useState<'base' | 'parent'>(hasBase ? 'base' : 'parent');
  const comparable = hasBase || variant.parentId !== null;
  const diff = useQuery({ ...diffQuery(variant.id, against), enabled: comparable });
  const [selected, setSelected] = useState<string | null>(null);
  const files = useMemo(() => (diff.data?.files ?? []).map(diffFileOf), [diff.data]);
  const listRef = useRef<HTMLDivElement>(null);
  const open = (path: string) => {
    setSelected(path);
    listRef.current
      ?.querySelector(`[data-path="${CSS.escape(path)}"]`)
      ?.scrollIntoView({ block: 'start' });
  };

  if (!comparable) {
    return (
      <p className="m-auto px-4 text-center text-sm text-muted-foreground">
        This variant has no base and was not derived from another variant, so there is nothing to
        compare.
      </p>
    );
  }
  return (
    <div className="flex min-h-0 min-w-0 flex-1">
      <div className="flex w-64 shrink-0 flex-col border-r text-sm">
        <div className="flex items-center gap-1 border-b p-1.5">
          {hasBase && (
            <Button
              size="xs"
              variant={against === 'base' ? 'secondary' : 'ghost'}
              onClick={() => {
                setAgainst('base');
              }}
            >
              Against base
            </Button>
          )}
          {variant.parentId !== null && (
            <Button
              size="xs"
              variant={against === 'parent' ? 'secondary' : 'ghost'}
              onClick={() => {
                setAgainst('parent');
              }}
            >
              Against source
            </Button>
          )}
          {diff.data !== undefined && (
            <span className="ml-auto pr-1 text-xs text-muted-foreground">
              {diff.data.files.length} {diff.data.files.length === 1 ? 'file' : 'files'}
            </span>
          )}
        </div>
        <nav aria-label="Changed files" className="min-h-0 flex-1 overflow-auto py-1">
          {diff.isPending && <p className="px-3 text-muted-foreground">Loading…</p>}
          {diff.isError && (
            <QueryError
              className="px-3"
              error={diff.error}
              retrying={diff.isFetching}
              onRetry={() => void diff.refetch()}
            />
          )}
          {diff.data?.files.length === 0 && (
            <p className="px-3 text-muted-foreground">The skills are identical; no differences.</p>
          )}
          {diff.data?.files.map((f) => (
            <button
              key={f.path}
              type="button"
              className={cn(
                'flex w-full flex-col items-start px-3 py-1 text-left hover:bg-accent',
                f.path === selected && 'bg-accent',
              )}
              onClick={() => {
                open(f.path);
              }}
            >
              <span className="w-full truncate font-mono text-xs">{f.path}</span>
              <span className="text-xs text-muted-foreground">{diffStatusLabel[f.status]}</span>
            </button>
          ))}
        </nav>
      </div>
      <div
        ref={listRef}
        className="min-h-0 min-w-0 flex-1 overflow-auto p-3"
        data-testid="skill-diff"
      >
        <DiffView
          key={against}
          files={files}
          viewType={viewType}
          sources={Object.fromEntries((diff.data?.files ?? []).map((f) => [f.path, f.oldContent]))}
        />
      </div>
    </div>
  );
}

// Log panel title: the result of the log shown (the latest build). A build start clears buildError and a
// failure sets it, so a non-null buildError means the latest build failed; after an edit buildStatus returns
// to none and builtHash still holds the last build
function lastBuildLabel(variant: Variant): string {
  const changed = variant.builtHash !== variant.skillsHash;
  if (variant.buildError !== null) {
    return variant.buildStatus === 'failed'
      ? 'Latest build failed'
      : 'Latest build failed; content changed since';
  }
  if (variant.builtHash === null || variant.builtAt === null) return 'Not built';
  const at = formatDateTime(variant.builtAt);
  return changed ? `Built ${at}; content changed since, needs rebuild` : `Built ${at}`;
}

// Collapsible build log panel at the bottom
function BuildLogPanel({ variant, building }: { variant: Variant; building: boolean }) {
  const log = useQuery({ ...buildLogQuery(variant.id, building), enabled: !isImported(variant) });
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [log.data]);
  if (isImported(variant)) {
    return <p className="p-3 text-sm text-muted-foreground">{importedLabel}. No build log.</p>;
  }
  if (log.isPending) return <p className="p-3 text-sm text-muted-foreground">Loading…</p>;
  if (log.isError) {
    return (
      <QueryError
        className="p-3"
        error={log.error}
        retrying={log.isFetching}
        onRetry={() => void log.refetch()}
      />
    );
  }
  // Skills the latest build registered and removed automatically (Contracts 16.4): the register-skills line in the log
  const registered = log.data
    .split('\n')
    .filter((line) => line.startsWith('[register-skills] ') && !line.endsWith(' s'))
    .at(-1)
    ?.slice('[register-skills] '.length);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {registered !== undefined && (
        <p className="border-b px-3 py-1 text-xs" data-testid="registered-skills">
          Registered skills: {registered}
        </p>
      )}
      <pre
        ref={ref}
        data-testid="build-log"
        className="min-h-0 flex-1 overflow-auto bg-muted/40 px-3 py-2 font-mono text-xs whitespace-pre-wrap"
      >
        {log.data === '' ? 'Not built yet. Click Build in the page header.' : log.data}
      </pre>
    </div>
  );
}

const TREE_WIDTH_KEY = 'wfd.variant.treeWidth';
const MIN_TREE = 160;
const MAX_TREE = 640;

function storedTreeWidth(): number {
  const raw = Number(localStorage.getItem(TREE_WIDTH_KEY) ?? '');
  return Number.isFinite(raw) && raw >= MIN_TREE && raw <= MAX_TREE ? raw : 256;
}

// Splitter between the file tree and the editor: drag to resize the tree; the width is kept in the browser
function Splitter({ width, onWidth }: { width: number; onWidth: (width: number) => void }) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    start.current = { x: event.clientX, width };
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current === null) return;
    const next = start.current.width + event.clientX - start.current.x;
    onWidth(Math.min(MAX_TREE, Math.max(MIN_TREE, next)));
  };
  const onPointerUp = () => {
    start.current = null;
    localStorage.setItem(TREE_WIDTH_KEY, String(width));
  };
  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Drag to resize the file tree"
      aria-valuenow={width}
      data-testid="tree-splitter"
      className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-foreground/30"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}

// Skill workspace (Contracts 20.2): a thin toolbar on top; below it a resizable, collapsible file tree and
// Monaco (or the diff); a collapsible build log panel at the bottom. The whole area can go full screen in the
// page (Contracts 20.1)
export function VariantWorkspace({
  variant,
  fullscreen,
  building,
  logOpen,
  onLogOpen,
}: {
  variant: Variant;
  fullscreen: Fullscreen;
  building: boolean;
  logOpen: boolean;
  onLogOpen: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const files = useQuery(filesQuery(variant.id));
  const [stored, setView] = useWorkspaceView();
  const [viewType] = useDiffViewType();
  // The open file is kept in ?file= so it stays open after a reload (including in full screen)
  const [params, setParams] = useSearchParams();
  const selected = params.get('file');
  const setSelected = (path: string | null) => {
    setParams(
      (current) => {
        const copy = new URLSearchParams(current);
        if (path === null) copy.delete('file');
        else copy.set('file', path);
        return copy;
      },
      { replace: true },
    );
  };
  const [status, setStatus] = useState<EditorStatus>(cleanStatus);
  const [treeOpen, setTreeOpen] = useState(true);
  const [treeWidth, setTreeWidth] = useState(storedTreeWidth);
  const saveRef = useRef<() => void>(() => undefined);
  const editable = variant.status === 'draft' && !isImported(variant);

  // With unsaved changes, confirm before switching; confirming discards them
  const select = (path: string) => {
    if (
      status.dirty &&
      !window.confirm('This file has unsaved changes. Switching will discard them. Continue?')
    )
      return;
    setStatus(cleanStatus);
    setSelected(path);
  };
  // Opens the workflow's entry skill by default
  const entry = `skills/${variant.workflowId}/SKILL.md`;
  const current = selected ?? files.data?.find((f) => f.path === entry)?.path ?? null;
  // Edit, preview, side by side and diff are one group (Contracts 21.2); non-.md files show preview and side by side as edit
  const view = effectiveView(stored, current);
  const mode = view === 'diff' ? 'diff' : 'edit';
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['variants'] });
  };
  const create = useMutation({
    mutationFn: (path: string) =>
      request<Variant>('PUT', `/api/variants/${variant.id}/file`, { path, content: '' }),
    onSuccess: async (_variant, path) => {
      await refresh();
      setSelected(path);
    },
  });
  const removeFile = useMutation({
    mutationFn: (path: string) =>
      request<Variant>(
        'DELETE',
        `/api/variants/${variant.id}/file?path=${encodeURIComponent(path)}`,
      ),
    onSuccess: async (_variant, path) => {
      queryClient.removeQueries({ queryKey: fileQuery(variant.id, path).queryKey });
      setSelected(null);
      setStatus(cleanStatus);
      await refresh();
    },
  });
  // Add, rename and delete skill directories (Contracts 16.4)
  const skills = useMutation({
    mutationFn: (
      op:
        | { kind: 'add'; name: string }
        | { kind: 'rename'; from: string; to: string }
        | { kind: 'delete'; name: string },
    ) =>
      op.kind === 'add'
        ? request<Variant>('POST', `/api/variants/${variant.id}/skills`, { name: op.name })
        : op.kind === 'rename'
          ? request<Variant>('PATCH', `/api/variants/${variant.id}/skills/${op.from}`, {
              name: op.to,
            })
          : request<Variant>('DELETE', `/api/variants/${variant.id}/skills/${op.name}`),
    onSuccess: async (_variant, op) => {
      setStatus(cleanStatus);
      setSelected(
        op.kind === 'add'
          ? `skills/${op.name}/SKILL.md`
          : op.kind === 'rename'
            ? `skills/${op.to}/SKILL.md`
            : null,
      );
      queryClient.removeQueries({ queryKey: ['variants', variant.id, 'file'] });
      await refresh();
    },
  });
  const actions: SkillActions | undefined = editable
    ? {
        onRename: (from) => {
          const to = window.prompt(`Rename skill ${from} to`, from);
          if (to !== null && to.trim() !== '' && to.trim() !== from) {
            skills.mutate({ kind: 'rename', from, to: to.trim() });
          }
        },
        onDelete: (name) => {
          if (window.confirm(`Delete the skill directory skills/${name}/ and all its files?`)) {
            skills.mutate({ kind: 'delete', name });
          }
        },
      }
    : undefined;
  const error = create.error ?? removeFile.error ?? skills.error;
  const saveState = status.saving
    ? 'Saving…'
    : status.error !== null
      ? `Save failed: ${status.error}`
      : status.dirty
        ? 'Unsaved'
        : 'Saved';

  return (
    <FullscreenArea
      active={fullscreen.active}
      testId="skill-workspace"
      className="flex h-[calc(100svh-12rem)] min-h-[28rem] flex-col overflow-hidden rounded-lg border"
    >
      {/* Thin toolbar: tree toggle, edit / preview / side by side / diff, file path and save state, save, build log toggle, full screen */}
      <div
        className="flex h-9 shrink-0 items-center gap-1 border-b px-1.5 text-sm"
        data-testid="workspace-toolbar"
      >
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={treeOpen ? 'Collapse file tree' : 'Expand file tree'}
          aria-pressed={treeOpen}
          title={treeOpen ? 'Collapse file tree' : 'Expand file tree'}
          data-testid="tree-toggle"
          onClick={() => {
            setTreeOpen(!treeOpen);
          }}
        >
          <PanelLeft />
        </Button>
        <div
          role="tablist"
          aria-label="Workspace view"
          className="flex rounded-md border p-0.5"
          data-testid="workspace-view"
          data-view={view}
        >
          {viewsOf(current).map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={view === id}
              className="rounded px-2 py-0.5 text-xs aria-selected:bg-foreground aria-selected:text-background"
              onClick={() => {
                setView(id);
              }}
            >
              {viewLabels[id]}
            </button>
          ))}
        </div>
        {mode === 'edit' && current !== null && (
          <>
            <span className="ml-2 min-w-0 truncate font-mono text-xs" data-testid="current-file">
              {current}
            </span>
            <span
              className={cn(
                'shrink-0 text-xs',
                status.error === null ? 'text-muted-foreground' : 'text-destructive',
              )}
              data-testid="save-state"
            >
              {saveState}
            </span>
          </>
        )}
        {error !== null && (
          <span role="alert" className="min-w-0 truncate text-xs text-destructive">
            {error.message}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {mode === 'diff' && <DiffViewTypeToggle className="mr-1" />}
          {mode === 'edit' && editable && current !== null && (
            <>
              <Button
                size="xs"
                variant="ghost"
                disabled={removeFile.isPending}
                onClick={() => {
                  if (window.confirm(`Delete ${current}?`)) removeFile.mutate(current);
                }}
              >
                <Trash2 />
                Delete file
              </Button>
              <Button
                size="xs"
                disabled={!status.dirty || status.saving}
                title="Save (⌘S)"
                onClick={() => {
                  saveRef.current();
                }}
              >
                <Save />
                Save
              </Button>
            </>
          )}
          <Button
            size="xs"
            variant={logOpen ? 'secondary' : 'ghost'}
            aria-expanded={logOpen}
            data-testid="log-toggle"
            onClick={() => {
              onLogOpen(!logOpen);
            }}
          >
            <PanelBottom />
            Build log
          </Button>
          <FullscreenButton active={fullscreen.active} onToggle={fullscreen.toggle} size="xs" />
        </div>
      </div>

      {/* In diff the editor is hidden, not unmounted: unsaved content, cursor and selection survive switching back */}
      <div className={cn('flex min-h-0 flex-1', mode === 'diff' && 'hidden')}>
        {treeOpen && (
          <>
            <div
              className="flex shrink-0 flex-col"
              style={{ width: treeWidth }}
              data-testid="file-tree"
            >
              <div className="flex items-center justify-between border-b px-3 py-1 text-xs font-medium text-muted-foreground">
                skills
                {editable && (
                  <span className="flex gap-0.5">
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="New skill directory"
                      title="New skill directory"
                      onClick={() => {
                        const name = window.prompt('New skill name (skills/<name>/SKILL.md)', '');
                        if (name !== null && name.trim() !== '') {
                          skills.mutate({ kind: 'add', name: name.trim() });
                        }
                      }}
                    >
                      <FolderPlus />
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label="New file"
                      title="New file"
                      onClick={() => {
                        const path = window.prompt(
                          'New file path (inside skills/<skill>/)',
                          current === null ? 'skills/' : current.replace(/[^/]+$/, ''),
                        );
                        if (path !== null && path.trim() !== '') create.mutate(path.trim());
                      }}
                    >
                      <FilePlus />
                    </Button>
                  </span>
                )}
              </div>
              <nav aria-label="Skill files" className="min-h-0 flex-1 overflow-auto py-1 text-sm">
                {files.isPending && <p className="px-3 text-muted-foreground">Loading…</p>}
                {files.isError && (
                  <QueryError
                    className="px-3"
                    error={files.error}
                    retrying={files.isFetching}
                    onRetry={() => void files.refetch()}
                  />
                )}
                {files.data !== undefined &&
                  buildTree(files.data).map((node) => (
                    <TreeItem
                      key={node.path}
                      node={node}
                      depth={0}
                      selected={current}
                      onSelect={select}
                      actions={node.children.length > 0 ? actions : undefined}
                    />
                  ))}
              </nav>
            </div>
            <Splitter width={treeWidth} onWidth={setTreeWidth} />
          </>
        )}
        {current === null ? (
          <p className="m-auto text-sm text-muted-foreground">Select a file on the left.</p>
        ) : (
          <FileEditor
            key={current}
            variant={variant}
            path={current}
            readOnly={!editable}
            view={view === 'diff' ? 'edit' : view}
            saveRef={saveRef}
            onStatus={setStatus}
            onOpenFile={select}
          />
        )}
      </div>
      {mode === 'diff' && (
        <div className="flex min-h-0 flex-1">
          <DiffPane variant={variant} viewType={viewType} />
        </div>
      )}

      {logOpen && (
        <div
          className="flex h-2/5 min-h-32 shrink-0 flex-col border-t"
          data-testid="build-log-panel"
        >
          <div className="flex h-7 shrink-0 items-center gap-2 border-b px-3 text-xs">
            <span className="font-medium">Build log</span>
            <span className="text-muted-foreground" data-testid="build-log-status">
              {building
                ? 'Building…'
                : isImported(variant)
                  ? importedLabel
                  : lastBuildLabel(variant)}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              className="ml-auto"
              aria-label="Collapse build log"
              title="Collapse build log"
              onClick={() => {
                onLogOpen(false);
              }}
            >
              <ChevronDown />
            </Button>
          </div>
          <BuildLogPanel variant={variant} building={building} />
        </div>
      )}
    </FullscreenArea>
  );
}
