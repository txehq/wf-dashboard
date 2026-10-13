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
import { type PointerEvent, type RefObject, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import {
  FullscreenArea,
  FullscreenButton,
  type Fullscreen,
  useFullscreenLayout,
} from '@/components/fullscreen';
import { SkillDiffEditor } from '@/components/skill-diff-editor';
import { Button } from '@/components/ui/button';
import { languageOf } from '@/lib/language';
import { cn } from '@/lib/utils';
import {
  buildLabel,
  buildLogQuery,
  diffQuery,
  fileQuery,
  filesQuery,
  importedLabel,
  isImported,
  request,
  type SkillFile,
  type Variant,
} from '@/pages/variants-api';
import { QueryError } from '@/pages/variants-error';
import { MONACO_THEME, monaco } from '@/pages/variants-monaco';

type MonacoEditor = Parameters<NonNullable<Parameters<typeof Editor>[0]['onMount']>>[0];

interface TreeNode {
  name: string;
  path: string;
  children: TreeNode[];
}

// 把 skills/a/b.md 这样的路径组成目录树，根是 skills/ 下的各个 skill
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

// skill 目录（skills/ 下第一层）的重命名与删除（Contracts 16.4）
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
  // 只给 skill 目录（depth 0）且 variant 可以编辑时
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
              aria-label={`重命名 skill ${node.name}`}
              title="重命名 skill 目录"
              onClick={() => {
                actions.onRename(node.name);
              }}
            >
              <Pencil />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`删除 skill ${node.name}`}
              title="删除 skill 目录"
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

// 编辑中的文件的状态，显示在工作区顶部的工具栏
export interface EditorStatus {
  dirty: boolean;
  saving: boolean;
  error: string | null;
}

const cleanStatus: EditorStatus = { dirty: false, saving: false, error: null };

function FileEditor({
  variant,
  path,
  readOnly,
  saveRef,
  onStatus,
}: {
  variant: Variant;
  path: string;
  readOnly: boolean;
  // 工具栏的"保存"与 ⌘S 调用它
  saveRef: RefObject<() => void>;
  onStatus: (status: EditorStatus) => void;
}) {
  const queryClient = useQueryClient();
  const file = useQuery(fileQuery(variant.id, path));
  const [draft, setDraft] = useState<string | null>(null);
  const editorRef = useRef<MonacoEditor | null>(null);
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
  // 进入与退出全屏后按新的尺寸重新排版；内容、光标与选区不变（同一个编辑器实例）
  useFullscreenLayout(() => {
    editorRef.current?.layout();
  });

  if (file.isPending) return <p className="p-4 text-sm text-muted-foreground">加载中…</p>;
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
  return (
    <div className="min-h-0 min-w-0 flex-1" data-testid="skill-editor">
      <Editor
        key={path}
        defaultValue={file.data.content}
        language={languageOf(path)}
        theme={MONACO_THEME}
        options={{
          readOnly,
          minimap: { enabled: false },
          wordWrap: 'on',
          fontSize: 13,
          scrollBeyondLastLine: false,
          // 拖动文件树宽度、收起面板时跟着容器重新排版
          automaticLayout: true,
        }}
        onChange={(value) => {
          setDraft(value ?? '');
        }}
        onMount={(editor) => {
          editorRef.current = editor;
          editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
            saveRef.current();
          });
        }}
      />
    </div>
  );
}

const diffStatusLabel = { added: '新增', removed: '删除', modified: '修改' } as const;

// 对比：左侧是改过的文件，右侧是 diff 编辑器
function DiffPane({ variant }: { variant: Variant }) {
  // 任意 workflow 的 variant 没有基线（Contracts 18.6），只能与来源对比
  const hasBase = variant.baseCommit !== '';
  const [against, setAgainst] = useState<'base' | 'parent'>(hasBase ? 'base' : 'parent');
  const comparable = hasBase || variant.parentId !== null;
  const diff = useQuery({ ...diffQuery(variant.id, against), enabled: comparable });
  const [selected, setSelected] = useState<string | null>(null);
  const file = diff.data?.files.find((f) => f.path === selected) ?? diff.data?.files[0];

  if (!comparable) {
    return (
      <p className="m-auto px-4 text-center text-sm text-muted-foreground">
        这个 variant 没有基线，也不是从别的 variant 派生的，没有可以对比的内容。
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
              与基线对比
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
              与来源对比
            </Button>
          )}
          {diff.data !== undefined && (
            <span className="ml-auto pr-1 text-xs text-muted-foreground">
              {diff.data.files.length} 个文件
            </span>
          )}
        </div>
        <nav aria-label="改过的文件" className="min-h-0 flex-1 overflow-auto py-1">
          {diff.isPending && <p className="px-3 text-muted-foreground">加载中…</p>}
          {diff.isError && (
            <QueryError
              className="px-3"
              error={diff.error}
              retrying={diff.isFetching}
              onRetry={() => void diff.refetch()}
            />
          )}
          {diff.data?.files.length === 0 && (
            <p className="px-3 text-muted-foreground">skills 内容相同，没有差异。</p>
          )}
          {diff.data?.files.map((f) => (
            <button
              key={f.path}
              type="button"
              className={cn(
                'flex w-full flex-col items-start px-3 py-1 text-left hover:bg-accent',
                f.path === file?.path && 'bg-accent',
              )}
              onClick={() => {
                setSelected(f.path);
              }}
            >
              <span className="w-full truncate font-mono text-xs">{f.path}</span>
              <span className="text-xs text-muted-foreground">{diffStatusLabel[f.status]}</span>
            </button>
          ))}
        </nav>
      </div>
      <div className="min-h-0 min-w-0 flex-1" data-testid="skill-diff">
        {file !== undefined && <SkillDiffEditor key={`${against}:${file.path}`} file={file} />}
      </div>
    </div>
  );
}

// 底部可收起的构建日志面板
function BuildLogPanel({ variant, building }: { variant: Variant; building: boolean }) {
  const log = useQuery({ ...buildLogQuery(variant.id, building), enabled: !isImported(variant) });
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [log.data]);
  if (isImported(variant)) {
    return <p className="p-3 text-sm text-muted-foreground">{importedLabel}，没有构建日志。</p>;
  }
  if (log.isPending) return <p className="p-3 text-sm text-muted-foreground">加载中…</p>;
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
  // 最近一次构建自动登记与删去的 skill（Contracts 16.4），即日志中 register-skills 的说明行
  const registered = log.data
    .split('\n')
    .filter((line) => line.startsWith('[register-skills] ') && !line.endsWith(' s'))
    .at(-1)
    ?.slice('[register-skills] '.length);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {registered !== undefined && (
        <p className="border-b px-3 py-1 text-xs" data-testid="registered-skills">
          自动登记的 skill：{registered}
        </p>
      )}
      <pre
        ref={ref}
        data-testid="build-log"
        className="min-h-0 flex-1 overflow-auto bg-muted/40 px-3 py-2 font-mono text-xs whitespace-pre-wrap"
      >
        {log.data === '' ? '还没有构建过。点页面头部的"构建"。' : log.data}
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

// 文件树与编辑器之间的分隔条：按住拖动改变文件树的宽度，宽度记在浏览器中
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
      aria-label="拖动改变文件树的宽度"
      aria-valuenow={width}
      data-testid="tree-splitter"
      className="w-1 shrink-0 cursor-col-resize bg-border hover:bg-foreground/30"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    />
  );
}

type Mode = 'edit' | 'diff';

// skill 编辑区（Contracts 20.2）：顶部一条细工具栏，下面是可拖动宽度、可收起的文件树与 Monaco（或 diff），
// 底部是可收起的构建日志面板。整个区域可以页面内全屏（Contracts 20.1）
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
  const [mode, setMode] = useState<Mode>('edit');
  // 打开的文件写在地址的 ?file= 中：刷新（包括全屏时）后仍打开它
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

  // 当前文件有未保存的修改时，切换前确认；确认后修改被丢弃
  const select = (path: string) => {
    if (status.dirty && !window.confirm('当前文件有未保存的修改，切换后会丢弃。继续？')) return;
    setStatus(cleanStatus);
    setSelected(path);
  };
  // 默认打开 workflow 的入口 skill
  const entry = `skills/${variant.workflowId}/SKILL.md`;
  const current = selected ?? files.data?.find((f) => f.path === entry)?.path ?? null;
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
  // skill 目录的新增、重命名与删除（Contracts 16.4）
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
          const to = window.prompt(`把 skill ${from} 改名为`, from);
          if (to !== null && to.trim() !== '' && to.trim() !== from) {
            skills.mutate({ kind: 'rename', from, to: to.trim() });
          }
        },
        onDelete: (name) => {
          if (window.confirm(`删除 skill 目录 skills/${name}/ 及其中的全部文件？`)) {
            skills.mutate({ kind: 'delete', name });
          }
        },
      }
    : undefined;
  const error = create.error ?? removeFile.error ?? skills.error;
  const saveState = status.saving
    ? '保存中…'
    : status.error !== null
      ? `保存失败：${status.error}`
      : status.dirty
        ? '未保存'
        : '已保存';

  return (
    <FullscreenArea
      active={fullscreen.active}
      testId="skill-workspace"
      className="flex h-[calc(100svh-12rem)] min-h-[28rem] flex-col overflow-hidden rounded-lg border"
    >
      {/* 顶部细工具栏：文件树开关、文件路径与保存状态、编辑与对比、保存、构建日志开关、全屏 */}
      <div
        className="flex h-9 shrink-0 items-center gap-1 border-b px-1.5 text-sm"
        data-testid="workspace-toolbar"
      >
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={treeOpen ? '收起文件树' : '展开文件树'}
          aria-pressed={treeOpen}
          title={treeOpen ? '收起文件树' : '展开文件树'}
          data-testid="tree-toggle"
          onClick={() => {
            setTreeOpen(!treeOpen);
          }}
        >
          <PanelLeft />
        </Button>
        <div role="tablist" aria-label="编辑或对比" className="flex rounded-md border p-0.5">
          {(
            [
              ['edit', '编辑'],
              ['diff', '对比'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={mode === id}
              className="rounded px-2 py-0.5 text-xs aria-selected:bg-foreground aria-selected:text-background"
              onClick={() => {
                setMode(id);
              }}
            >
              {label}
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
          {mode === 'edit' && editable && current !== null && (
            <>
              <Button
                size="xs"
                variant="ghost"
                disabled={removeFile.isPending}
                onClick={() => {
                  if (window.confirm(`删除 ${current}？`)) removeFile.mutate(current);
                }}
              >
                <Trash2 />
                删除文件
              </Button>
              <Button
                size="xs"
                disabled={!status.dirty || status.saving}
                title="保存（⌘S）"
                onClick={() => {
                  saveRef.current();
                }}
              >
                <Save />
                保存
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
            构建日志
          </Button>
          <FullscreenButton active={fullscreen.active} onToggle={fullscreen.toggle} size="xs" />
        </div>
      </div>

      {/* 对比时编辑区只隐藏不卸载：未保存的内容、光标与选区在切回后不变 */}
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
                      aria-label="新增 skill 目录"
                      title="新增 skill 目录"
                      onClick={() => {
                        const name = window.prompt('新 skill 的名字（skills/<名字>/SKILL.md）', '');
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
                      aria-label="新建文件"
                      title="新建文件"
                      onClick={() => {
                        const path = window.prompt(
                          '新文件路径（skills/<skill>/ 以内）',
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
              <nav aria-label="skills 文件" className="min-h-0 flex-1 overflow-auto py-1 text-sm">
                {files.isPending && <p className="px-3 text-muted-foreground">加载中…</p>}
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
          <p className="m-auto text-sm text-muted-foreground">在左侧选择一个文件。</p>
        ) : (
          <FileEditor
            key={current}
            variant={variant}
            path={current}
            readOnly={!editable}
            saveRef={saveRef}
            onStatus={setStatus}
          />
        )}
      </div>
      {mode === 'diff' && (
        <div className="flex min-h-0 flex-1">
          <DiffPane variant={variant} />
        </div>
      )}

      {logOpen && (
        <div
          className="flex h-2/5 min-h-32 shrink-0 flex-col border-t"
          data-testid="build-log-panel"
        >
          <div className="flex h-7 shrink-0 items-center gap-2 border-b px-3 text-xs">
            <span className="font-medium">构建日志</span>
            <span className="text-muted-foreground">
              {building ? '构建中…' : isImported(variant) ? importedLabel : buildLabel(variant)}
            </span>
            <Button
              size="icon-xs"
              variant="ghost"
              className="ml-auto"
              aria-label="收起构建日志"
              title="收起构建日志"
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
