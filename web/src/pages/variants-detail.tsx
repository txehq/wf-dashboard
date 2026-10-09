import { DiffEditor, Editor } from '@monaco-editor/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, FilePlus, FileText, Hammer, Save, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  buildLabel,
  buildLogQuery,
  diffQuery,
  type FileDiff,
  fileQuery,
  filesQuery,
  request,
  type SkillFile,
  statusLabel,
  type Variant,
  variantOptionsQuery,
  variantQuery,
} from '@/pages/variants-api';
import { monaco } from '@/pages/variants-monaco';

type Tab = 'edit' | 'diff' | 'log';

function languageOf(path: string): string {
  if (path.endsWith('.md')) return 'markdown';
  if (path.endsWith('.sh')) return 'shell';
  if (path.endsWith('.py')) return 'python';
  if (path.endsWith('.ts')) return 'typescript';
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.yaml') || path.endsWith('.yml')) return 'yaml';
  return 'plaintext';
}

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

function TreeItem({
  node,
  depth,
  selected,
  onSelect,
}: {
  node: TreeNode;
  depth: number;
  selected: string | null;
  onSelect: (path: string) => void;
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
      <button
        type="button"
        style={indent}
        aria-expanded={open}
        className="flex w-full items-center gap-1 rounded py-0.5 pr-2 text-left hover:bg-accent"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate">{node.name}</span>
      </button>
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
}: {
  variant: Variant;
  path: string;
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const file = useQuery(fileQuery(variant.id, path));
  const [draft, setDraft] = useState<string | null>(null);
  const frozen = variant.status === 'frozen';
  const dirty = draft !== null && draft !== file.data?.content;
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
      if (dirty && !frozen) save.mutate(draft);
    };
  });

  if (file.isPending) return <p className="p-4 text-sm text-muted-foreground">加载中…</p>;
  if (file.isError) return <p className="p-4 text-sm text-destructive">{file.error.message}</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2 text-sm">
        <span className="font-mono">{path}</span>
        {dirty && <span className="text-xs text-muted-foreground">未保存</span>}
        {save.isError && <span className="text-xs text-destructive">{save.error.message}</span>}
        {remove.isError && <span className="text-xs text-destructive">{remove.error.message}</span>}
        {!frozen && (
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
            readOnly: frozen,
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
  const current =
    selected ?? files.data?.find((f) => f.path === 'skills/lfg/SKILL.md')?.path ?? null;
  const create = useMutation({
    mutationFn: (path: string) =>
      request<Variant>('PUT', `/api/variants/${variant.id}/file`, { path, content: '' }),
    onSuccess: async (_variant, path) => {
      await queryClient.invalidateQueries({ queryKey: ['variants'] });
      setSelected(path);
    },
  });

  return (
    <div className="flex h-[calc(100svh-15rem)] min-h-96 rounded-lg border">
      <div className="flex w-64 shrink-0 flex-col border-r">
        <div className="flex items-center justify-between border-b px-3 py-2 text-sm font-medium">
          skills
          {variant.status === 'draft' && (
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
          )}
        </div>
        {create.isError && (
          <p className="px-3 py-1 text-xs text-destructive">{create.error.message}</p>
        )}
        <nav aria-label="skills 文件" className="min-h-0 flex-1 overflow-auto py-1 text-sm">
          {files.isPending && <p className="px-3 text-muted-foreground">加载中…</p>}
          {files.isError && <p className="px-3 text-destructive">{files.error.message}</p>}
          {files.data !== undefined &&
            buildTree(files.data).map((node) => (
              <TreeItem
                key={node.path}
                node={node}
                depth={0}
                selected={current}
                onSelect={setSelected}
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
        />
      )}
    </div>
  );
}

const diffStatusLabel = { added: '新增', removed: '删除', modified: '修改' } as const;

// @monaco-editor/react 卸载时先释放 model 再释放 DiffEditor，monaco 0.57 会因此报错；
// 改为保留 model，等这次提交里的卸载全部完成、DiffEditor 已释放后再释放 model
function SkillDiffEditor({ file }: { file: FileDiff }) {
  const models = useRef<monaco.editor.IDiffEditorModel | null>(null);
  useEffect(
    () => () => {
      const current = models.current;
      setTimeout(() => {
        current?.original.dispose();
        current?.modified.dispose();
      });
    },
    [],
  );
  return (
    <DiffEditor
      original={file.oldContent}
      modified={file.newContent}
      language={languageOf(file.path)}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      onMount={(editor) => {
        models.current = editor.getModel();
      }}
      options={{
        readOnly: true,
        renderSideBySide: true,
        minimap: { enabled: false },
        wordWrap: 'on',
        fontSize: 13,
        scrollBeyondLastLine: false,
      }}
    />
  );
}

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
          {diff.isError && <p className="px-3 text-destructive">{diff.error.message}</p>}
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
  const log = useQuery(buildLogQuery(variant.id, building));
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    ref.current?.scrollTo({ top: ref.current.scrollHeight });
  }, [log.data]);
  if (log.isPending) return <p className="text-sm text-muted-foreground">加载中…</p>;
  if (log.isError) return <p className="text-sm text-destructive">{log.error.message}</p>;
  return (
    <pre
      ref={ref}
      data-testid="build-log"
      className="h-[calc(100svh-15rem)] min-h-96 overflow-auto rounded-lg border bg-muted/40 p-4 font-mono text-xs whitespace-pre-wrap"
    >
      {log.data}
    </pre>
  );
}

function Settings({ variant }: { variant: Variant }) {
  const queryClient = useQueryClient();
  const options = useQuery(variantOptionsQuery);
  const update = useMutation({
    mutationFn: (body: { model?: string; effort?: string }) =>
      request<Variant>('PATCH', `/api/variants/${variant.id}`, body),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['variants'] });
    },
  });
  const frozen = variant.status === 'frozen';
  return (
    <div className="flex items-center gap-3 text-sm">
      <label className="flex items-center gap-2">
        模型
        <select
          className="h-8 rounded-md border bg-background px-2"
          value={variant.model}
          disabled={frozen || options.data === undefined}
          onChange={(event) => {
            update.mutate({ model: event.target.value });
          }}
        >
          {options.data?.models.map((m) => (
            <option key={m.alias} value={m.alias}>
              {m.alias}（{m.model}）
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-2">
        effort
        <select
          className="h-8 rounded-md border bg-background px-2"
          value={variant.effort}
          disabled={frozen || options.data === undefined}
          onChange={(event) => {
            update.mutate({ effort: event.target.value });
          }}
        >
          {options.data?.efforts.map((e) => (
            <option key={e} value={e}>
              {e}
            </option>
          ))}
        </select>
      </label>
      {update.isError && <span className="text-destructive">{update.error.message}</span>}
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
      await navigate(`/variants/${created.id}`);
    },
  });
  const frozen = variant.status === 'frozen';
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{variant.name}</h1>
        <span className="rounded-md border px-2 py-0.5 text-xs">{statusLabel[variant.status]}</span>
        <span className="rounded-md border px-2 py-0.5 text-xs" data-testid="build-status">
          {buildLabel(variant)}
        </span>
        <span className="font-mono text-xs text-muted-foreground">
          {variant.version} · 基线 {variant.baseCommit.slice(0, 7)}
        </span>
      </div>
      {frozen && (
        <p className="text-sm text-muted-foreground">
          已被运行使用，内容只读。修改请另存为新 variant。
        </p>
      )}
      {variant.buildStatus === 'failed' && variant.buildError !== null && (
        <p className="text-sm text-destructive">{variant.buildError}</p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Settings variant={variant} />
        <div className="ml-auto flex gap-2">
          <Button
            variant={frozen ? 'default' : 'outline'}
            disabled={derive.isPending}
            onClick={() => {
              const name = window.prompt('新 variant 名称', `${variant.name} 副本`);
              if (name !== null && name.trim() !== '') derive.mutate(name.trim());
            }}
          >
            另存为新 variant
          </Button>
          {!frozen && (
            <Button disabled={building} onClick={onBuild}>
              <Hammer />
              {building ? '构建中…' : '构建并安装'}
            </Button>
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

export function VariantDetailPage() {
  const { id } = useParams();
  if (id === undefined) throw new Error('路由缺少 variant id');
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
  if (variant.isError) return <p className="text-sm text-destructive">{variant.error.message}</p>;
  const building = build.isPending || variant.data.buildStatus === 'building';

  return (
    <div className="flex flex-col gap-4">
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
