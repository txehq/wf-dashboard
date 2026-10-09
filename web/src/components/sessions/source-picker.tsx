import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, FolderOpen, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { formatDateTime, formatInteger } from '@/lib/format';
import { putSources, sourcesQuery, type ImportResult, type Source } from '@/lib/sessions-api';

// 只显示目录名，完整路径放在 title 中
function sourceName(source: Source): string {
  const parts = source.path.split('/');
  return parts[parts.length - 1] ?? source.path;
}

function SourceRow({
  source,
  disabled,
  onToggle,
}: {
  source: Source;
  disabled: boolean;
  onToggle: (checked: boolean) => void;
}) {
  const fixed = source.variant !== null;
  return (
    <li>
      <label
        className="flex items-center gap-3 rounded-md px-3 py-2 hover:bg-muted/60 has-[:disabled]:hover:bg-transparent"
        title={source.path}
      >
        <input
          type="checkbox"
          aria-label={source.path}
          className="size-4 accent-foreground"
          checked={source.checked}
          disabled={disabled || fixed}
          onChange={(event) => {
            onToggle(event.target.checked);
          }}
        />
        <span className="min-w-0 flex-1 truncate font-mono text-xs">{sourceName(source)}</span>
        {fixed && (
          <span className="rounded border px-1.5 py-0.5 text-xs text-muted-foreground">
            variant {source.variant}
          </span>
        )}
        <span className="w-20 text-right text-xs tabular-nums text-muted-foreground">
          {formatInteger(source.sessionCount)} 个 session
        </span>
        <span className="w-28 text-right text-xs tabular-nums text-muted-foreground">
          {source.lastModified === null ? '—' : formatDateTime(source.lastModified)}
        </span>
      </label>
    </li>
  );
}

export function SourcePicker() {
  const client = useQueryClient();
  const sources = useQuery(sourcesQuery);
  const [open, setOpen] = useState<boolean | null>(null);
  const [lastImport, setLastImport] = useState<ImportResult['imported'] | null>(null);
  const save = useMutation({
    mutationFn: putSources,
    // 导入需要几秒，勾选状态先行更新
    onMutate: (paths) => {
      const checked = new Set(paths);
      client.setQueryData(sourcesQuery.queryKey, (prev) =>
        prev?.map((s) => (s.variant === null ? { ...s, checked: checked.has(s.path) } : s)),
      );
    },
    onError: () => {
      void client.invalidateQueries({ queryKey: sourcesQuery.queryKey });
    },
    onSuccess: (result) => {
      client.setQueryData(sourcesQuery.queryKey, result.sources);
      setLastImport(result.imported);
      void client.invalidateQueries({ queryKey: ['sessions'] });
    },
  });

  if (sources.isPending) return <p className="text-sm text-muted-foreground">正在读取来源目录…</p>;
  if (sources.isError)
    return (
      <p role="alert" className="text-sm text-destructive">
        读取来源目录失败：{sources.error.message}
      </p>
    );

  const list = sources.data;
  const home = list.filter((s) => s.variant === null);
  const checkedHome = home.filter((s) => s.checked);
  const checkedCount = list.filter((s) => s.checked).length;
  // 一个都没勾选时默认展开
  const expanded = open ?? checkedCount === 0;

  const toggle = (source: Source, checked: boolean) => {
    const paths = checkedHome.map((s) => s.path).filter((p) => p !== source.path);
    if (checked) paths.push(source.path);
    // 勾选后保持展开，不随“一个都没勾选”的默认值收起
    setOpen(true);
    save.mutate(paths);
  };

  return (
    <section aria-label="来源目录" className="rounded-lg border">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-4 py-3 text-left"
        aria-expanded={expanded}
        onClick={() => {
          setOpen(!expanded);
        }}
      >
        <FolderOpen className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">来源目录</span>
        <span className="text-sm text-muted-foreground">
          已勾选 {checkedCount} / {list.length}
        </span>
        {save.isPending && (
          <span className="flex items-center gap-1 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            正在导入…
          </span>
        )}
        {!save.isPending && lastImport !== null && (
          <span className="text-sm text-muted-foreground" data-testid="import-result">
            已导入 {lastImport.files} 个文件，{lastImport.changedSessions} 个 session 有更新
          </span>
        )}
        <ChevronDown
          className={`ml-auto size-4 transition-transform ${expanded ? 'rotate-180' : ''}`}
        />
      </button>
      {save.isError && (
        <p role="alert" className="px-4 pb-3 text-sm text-destructive">
          导入失败：{save.error.message}
        </p>
      )}
      {expanded &&
        (list.length === 0 ? (
          <p className="border-t px-4 py-3 text-sm text-muted-foreground">
            ~/.claude/projects 下还没有目录。
          </p>
        ) : (
          <ul className="max-h-80 overflow-y-auto border-t p-2">
            {list.map((source) => (
              <SourceRow
                key={source.path}
                source={source}
                disabled={save.isPending}
                onToggle={(checked) => {
                  toggle(source, checked);
                }}
              />
            ))}
          </ul>
        ))}
    </section>
  );
}
