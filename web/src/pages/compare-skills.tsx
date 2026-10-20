import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { SkillDiffEditor } from '@/components/skill-diff-editor';
import { type SelectedVariant, skillDiffQuery } from '@/lib/compare';
import { cn } from '@/lib/utils';

const diffStatusLabel = { added: '新增', removed: '删除', modified: '修改' } as const;

function VariantSelect({
  label,
  value,
  variants,
  onChange,
}: {
  label: string;
  value: string;
  variants: SelectedVariant[];
  onChange: (id: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      {label}
      <select
        aria-label={label}
        className="h-8 rounded-md border bg-background px-2"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {variants.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>
    </label>
  );
}

function DiffView({ from, to }: { from: string; to: string }) {
  const diff = useQuery(skillDiffQuery(from, to));
  const [selected, setSelected] = useState<string | null>(null);
  const file = diff.data?.files.find((f) => f.path === selected) ?? diff.data?.files[0];
  return (
    <div className="flex h-[560px] rounded-lg border">
      <div className="flex w-64 shrink-0 flex-col border-r text-sm">
        <div className="border-b px-3 py-2 text-xs text-muted-foreground">
          {diff.data === undefined ? '' : `${String(diff.data.files.length)} 个文件不同`}
        </div>
        <div className="min-h-0 flex-1 overflow-auto py-1" aria-label="不同的文件">
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
      <div className="min-h-0 min-w-0 flex-1" data-testid="skill-diff">
        {file !== undefined && (
          <SkillDiffEditor key={`${from}:${to}:${file.path}`} file={file} collapseUnchanged />
        )}
      </div>
    </div>
  );
}

export function SkillDiffSection({ variants }: { variants: SelectedVariant[] }) {
  const [baseline, second] = variants;
  const [picked, setPicked] = useState<{ from: string; to: string } | null>(null);
  if (baseline === undefined || second === undefined) {
    return <p className="text-sm text-muted-foreground">至少选择两个 variant。</p>;
  }
  const ids = new Set(variants.map((v) => v.id));
  const current =
    picked !== null && ids.has(picked.from) && ids.has(picked.to)
      ? picked
      : { from: baseline.id, to: second.id };
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-4">
        <VariantSelect
          label="旧"
          value={current.from}
          variants={variants}
          onChange={(id) => {
            setPicked({ ...current, from: id });
          }}
        />
        <VariantSelect
          label="新"
          value={current.to}
          variants={variants}
          onChange={(id) => {
            setPicked({ ...current, to: id });
          }}
        />
      </div>
      <DiffView key={`${current.from}:${current.to}`} from={current.from} to={current.to} />
    </div>
  );
}
