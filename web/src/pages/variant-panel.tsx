import { Editor } from '@monaco-editor/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronRight,
  FilePlus,
  FileText,
  FolderPlus,
  Hammer,
  Pencil,
  Save,
  Trash2,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { OpenInFinder } from '@/components/open-in-finder';
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
  statusLabel,
  type Variant,
  variantHref,
  variantLabel,
  variantQuery,
} from '@/pages/variants-api';
import { QueryError } from '@/pages/variants-error';
import { monaco } from '@/pages/variants-monaco';

type Tab = 'edit' | 'diff' | 'log';

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

function FileEditor({
  variant,
  path,
  onDeleted,
  onDirtyChange,
}: {
  variant: Variant;
  path: string;
  onDeleted: () => void;
  // 是否有未保存的修改，切换文件前据此确认
  onDirtyChange: (dirty: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const file = useQuery(fileQuery(variant.id, path));
  const [draft, setDraft] = useState<string | null>(null);
  const readOnly = variant.status === 'frozen' || isImported(variant);
  const dirty = draft !== null && draft !== file.data?.content;
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  const saveRef = useRef<() => void>(() => undefined);

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['variants'] });
  };
  const save = useMutation({
    mutationFn: (content: string) =>
      request<Variant>('PUT', `/api/variants/${variant.id}/file`, { path, content }),
    onSuccess: async (_variant, content) => {
      queryClient.setQueryData(fileQuery(variant.id, path).queryKey, { path, content });
      setDraft(null);
      await refresh();
    },
  });
  const remove = useMutation({
    mutationFn: () =>
      request<Variant>(
        'DELETE',
        `/api/variants/${variant.id}/file?path=${encodeURIComponent(path)}`,
      ),
    onSuccess: async () => {
      queryClient.removeQueries({ queryKey: fileQuery(variant.id, path).queryKey });
      onDeleted();
      await refresh();
    },
  });

  useEffect(() => {
    saveRef.current = () => {
      if (dirty && !readOnly) save.mutate(draft);
    };
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
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-sm">
        <span className="font-mono">{path}</span>
        {dirty && <span className="text-xs text-muted-foreground">未保存</span>}
        {save.isError && <span className="text-xs text-destructive">{save.error.message}</span>}
        {remove.isError && <span className="text-xs text-destructive">{remove.error.message}</span>}
        {!readOnly && (
          <div className="ml-auto flex gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`删除 ${path}？`)) remove.mutate();
              }}
            >
              <Trash2 />
              删除
            </Button>
            <Button
              size="sm"
              disabled={!dirty || save.isPending}
              onClick={() => {
                saveRef.current();
              }}
            >
              <Save />
              {save.isPending ? '保存中…' : '保存'}
            </Button>
          </div>
        )}
      </div>
      <div className="min-h-0 flex-1" data-testid="skill-editor">
        <Editor
          key={path}
          defaultValue={file.data.content}
          language={languageOf(path)}
          options={{
            readOnly,
            minimap: { enabled: false },
            wordWrap: 'on',
            fontSize: 13,
            scrollBeyondLastLine: false,
          }}
          onChange={(value) => {
            setDraft(value ?? '');
          }}
          onMount={(editor) => {
            editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
              saveRef.current();
            });
          }}
        />
      </div>
    </div>
  );
}

function EditTab({ variant }: { variant: Variant }) {
  const queryClient = useQueryClient();
  const files = useQuery(filesQuery(variant.id));
  const [selected, setSelected] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const editable = variant.status === 'draft' && !isImported(variant);
  // 当前文件有未保存的修改时，切换前确认；确认后修改被丢弃
  const select = (path: string) => {
    if (dirty && !window.confirm('当前文件有未保存的修改，切换后会丢弃。继续？')) return;
    setDirty(false);
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
      setDirty(false);
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

  return (
    <div className="flex h-[calc(100svh-15rem)] min-h-96 rounded-lg border">
      <div className="flex w-64 shrink-0 flex-col border-r">
        <div className="flex items-center justify-between border-b px-3 py-2 text-sm font-medium">
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
        {create.isError && (
          <p className="px-3 py-1 text-xs text-destructive">{create.error.message}</p>
        )}
        {skills.isError && (
          <p role="alert" className="px-3 py-1 text-xs text-destructive">
            {skills.error.message}
          </p>
        )}
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
      {current === null ? (
        <p className="p-4 text-sm text-muted-foreground">在左侧选择一个文件。</p>
      ) : (
        <FileEditor
          key={current}
          variant={variant}
          path={current}
          onDeleted={() => {
            setSelected(null);
          }}
          onDirtyChange={setDirty}
        />
      )}
    </div>
  );
}

const diffStatusLabel = { added: '新增', removed: '删除', modified: '修改' } as const;

function DiffTab({ variant }: { variant: Variant }) {
  const [against, setAgainst] = useState<'base' | 'parent'>('base');
  const diff = useQuery(diffQuery(variant.id, against));
  const [selected, setSelected] = useState<string | null>(null);
  const file = diff.data?.files.find((f) => f.path === selected) ?? diff.data?.files[0];

  return (
    <div className="flex h-[calc(100svh-15rem)] min-h-96 rounded-lg border">
      <div className="flex w-64 shrink-0 flex-col border-r text-sm">
        <div className="flex gap-1 border-b p-2">
          <Button
            size="xs"
            variant={against === 'base' ? 'secondary' : 'ghost'}
            onClick={() => {
              setAgainst('base');
            }}
          >
            与基线对比
          </Button>
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
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1">
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
        </div>
      </div>
      <div className="min-h-0 flex-1" data-testid="skill-diff">
        {file !== undefined && <SkillDiffEditor key={`${against}:${file.path}`} file={file} />}
      </div>
    </div>
  );
}

function LogTab({ variant, building }: { variant: Variant; building: boolean }) {
  if (isImported(variant)) {
    return <p className="text-sm text-muted-foreground">{importedLabel}，没有构建日志。</p>;
  }
  return <BuildLog variant={variant} building={building} />;
}

function BuildLog({ variant, building }: { variant: Variant; building: boolean }) {
  const log = useQuery(buildLogQuery(variant.id, building));
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [log.data]);
  if (log.isPending) return <p className="text-sm text-muted-foreground">加载中…</p>;
  if (log.isError) {
    return (
      <QueryError error={log.error} retrying={log.isFetching} onRetry={() => void log.refetch()} />
    );
  }
  // 最近一次构建自动登记与删去的 skill（Contracts 16.4），即日志中 register-skills 的说明行
  const registered = log.data
    .split('\n')
    .filter((line) => line.startsWith('[register-skills] ') && !line.endsWith(' s'))
    .at(-1)
    ?.slice('[register-skills] '.length);
  return (
    <div className="flex flex-col gap-2">
      {registered !== undefined && (
        <p className="text-sm" data-testid="registered-skills">
          自动登记的 skill：{registered}
        </p>
      )}
      <pre
        ref={ref}
        data-testid="build-log"
        className="h-[calc(100svh-15rem)] min-h-96 overflow-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs whitespace-pre-wrap"
      >
        {log.data}
      </pre>
    </div>
  );
}

function Header({
  variant,
  building,
  onBuild,
}: {
  variant: Variant;
  building: boolean;
  onBuild: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const derive = useMutation({
    mutationFn: (name: string) =>
      request<Variant>('POST', `/api/variants/${variant.id}/derive`, { name }),
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['variants'] });
      await navigate(variantHref(created));
    },
  });
  const frozen = variant.status === 'frozen';
  const imported = isImported(variant);
  const parent = useQuery({
    ...variantQuery(variant.parentId ?? ''),
    enabled: variant.parentId !== null,
  });
  const deriveButton = (label: string, defaultName: string) => (
    <Button
      variant={frozen || imported ? 'default' : 'outline'}
      disabled={derive.isPending}
      onClick={() => {
        const name = window.prompt('新 variant 名称', defaultName);
        if (name !== null && name.trim() !== '') derive.mutate(name.trim());
      }}
    >
      {label}
    </Button>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-xl font-semibold">{variantLabel(variant)}</h2>
        <span className="rounded-md border px-2 py-0.5 text-xs">{statusLabel[variant.status]}</span>
        <span className="rounded-md border px-2 py-0.5 text-xs" data-testid="build-status">
          {imported ? importedLabel : buildLabel(variant)}
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {variant.version} · 基线 {variant.baseCommit.slice(0, 7)}
        </span>
        <OpenInFinder target={{ kind: 'variant', id: variant.id }} label="在访达中打开" />
      </div>
      {variant.parentId !== null && (
        <p className="text-sm text-muted-foreground" data-testid="variant-parent">
          派生自{' '}
          {parent.data === undefined ? (
            variant.parentId
          ) : (
            <Link className="underline" to={variantHref(parent.data)}>
              {variantLabel(parent.data)}
            </Link>
          )}
          {parent.data !== undefined && isImported(parent.data) && '（导入的 variant）'}
        </p>
      )}
      {variant.storageId !== null && (
        <p className="text-sm text-muted-foreground" data-testid="variant-shared">
          与另一个 workflow 的同名 variant 共用目录，编辑或构建时复制出自己的一份。
        </p>
      )}
      {variant.analysisId !== null && (
        <p className="text-sm text-muted-foreground" data-testid="variant-analysis">
          来自分析{' '}
          <Link className="font-mono underline" to={`/analyses/${variant.analysisId}`}>
            {variant.analysisId}
          </Link>
        </p>
      )}
      {variant.sourceSessionId !== null && (
        <p className="text-sm text-muted-foreground" data-testid="variant-source-session">
          按 session{' '}
          <Link className="font-mono underline" to={`/sessions/${variant.sourceSessionId}`}>
            {variant.sourceSessionId.slice(0, 8)}
          </Link>{' '}
          的 skill 新建
        </p>
      )}
      {frozen && !imported && (
        <p className="text-sm text-muted-foreground">
          已被运行使用，内容只读。修改请另存为新 variant。
        </p>
      )}
      {variant.buildStatus === 'failed' && variant.buildError !== null && (
        <p className="text-sm text-destructive">{variant.buildError}</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <div className="ml-auto flex gap-2">
          {imported ? (
            deriveButton('派生为可运行的 variant', `${variant.name}（可运行）`)
          ) : (
            <>
              {deriveButton('另存为新 variant', `${variant.name} 副本`)}
              {!frozen && (
                <Button disabled={building} onClick={onBuild}>
                  <Hammer />
                  {building ? '构建中…' : '构建并安装'}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
      {derive.isError && <p className="text-sm text-destructive">{derive.error.message}</p>}
    </div>
  );
}

const tabs: { id: Tab; label: string }[] = [
  { id: 'edit', label: '编辑' },
  { id: 'diff', label: '对比' },
  { id: 'log', label: '构建日志' },
];

// 原 variant 详情的全部内容，在它所属 workflow 的页面中展开（Contracts 16.7）
export function VariantPanel({ id }: { id: string }) {
  const queryClient = useQueryClient();
  const variant = useQuery(variantQuery(id));
  const [tab, setTab] = useState<Tab>('edit');
  const build = useMutation({
    mutationFn: () => request<Variant>('POST', `/api/variants/${id}/build`),
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['variants'] });
    },
  });

  if (variant.isPending) return <p className="text-sm text-muted-foreground">加载中…</p>;
  if (variant.isError) {
    return (
      <QueryError
        error={variant.error}
        retrying={variant.isFetching}
        onRetry={() => void variant.refetch()}
      />
    );
  }
  const building = build.isPending || variant.data.buildStatus === 'building';

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4" data-testid="variant-panel">
      <Header
        variant={variant.data}
        building={building}
        onBuild={() => {
          setTab('log');
          build.mutate();
        }}
      />
      {build.isError && <p className="text-sm text-destructive">{build.error.message}</p>}
      <div role="tablist" className="flex gap-1 border-b">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={tab === t.id}
            className={cn(
              '-mb-px border-b-2 border-transparent px-3 py-1.5 text-sm text-muted-foreground',
              tab === t.id && 'border-foreground font-medium text-foreground',
            )}
            onClick={() => {
              setTab(t.id);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      {tab === 'edit' && <EditTab variant={variant.data} />}
      {tab === 'diff' && <DiffTab variant={variant.data} />}
      {tab === 'log' && <LogTab variant={variant.data} building={building} />}
    </div>
  );
}
