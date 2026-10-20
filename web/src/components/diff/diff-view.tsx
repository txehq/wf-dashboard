import { ChevronDown, ChevronRight, UnfoldVertical } from 'lucide-react';
import { Fragment, type ReactNode, useMemo, useState } from 'react';
import {
  Decoration,
  Diff,
  type DiffType,
  Hunk,
  type HunkData,
  markEdits,
  textLinesToHunk,
  tokenize,
  type ViewType,
} from 'react-diff-view';
import 'react-diff-view/style/index.css';
import './colors.css';
import './diff.css';
import { cn } from '@/lib/utils';
import { type DiffFile, type DiffStatus, gapBetween, hunkTitle, splitLines } from './model';

const diffTypes: Record<DiffStatus, DiffType> = {
  added: 'add',
  removed: 'delete',
  modified: 'modify',
};

const statusLabels: Record<DiffStatus, string | null> = {
  added: '新增',
  removed: '删除',
  modified: null,
};

const hunkKey = (h: HunkData) => `${String(h.oldStart)}:${String(h.newStart)}`;

// 一个文件的改动（Contracts 21.3）：删除的行红底、新增的行绿底、行首 - 与 +、两侧行号、行内改动的词加深。
// 给出原文 source 时，hunk 之间没有改动的行折叠成一行，点击展开；renderHunkHeader 在每个 hunk 上方加一行
export function DiffHunks({
  hunks,
  status = 'modified',
  viewType,
  source,
  renderHunkHeader,
}: {
  hunks: HunkData[];
  status?: DiffStatus;
  viewType: ViewType;
  source?: string | undefined;
  renderHunkHeader?: ((hunk: HunkData, index: number) => ReactNode) | undefined;
}) {
  // 已展开的间隔：第 i 个是第 i 个 hunk 之前的，最后一个是文件结尾的
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const lines = useMemo(
    () => (source === undefined ? null : splitLines(source).map((l) => l.replace(/\n$/, ''))),
    [source],
  );

  const gaps = useMemo(() => {
    if (lines === null) return [];
    return [...hunks, null].map((next, i) => {
      const gap = gapBetween(hunks[i - 1] ?? null, next, lines.length);
      const hunk = expanded.has(i)
        ? textLinesToHunk(lines.slice(gap.from, gap.to), gap.from + 1, gap.newFrom + 1)
        : null;
      return { count: gap.to - gap.from, hunk };
    });
  }, [hunks, lines, expanded]);

  const rendered = useMemo(() => {
    const all: HunkData[] = [];
    for (const [i, hunk] of hunks.entries()) {
      const gap = gaps[i]?.hunk;
      if (gap != null) all.push(gap);
      all.push(hunk);
    }
    const last = gaps[hunks.length]?.hunk;
    if (last != null) all.push(last);
    return all;
  }, [hunks, gaps]);

  const tokens = useMemo(
    () => tokenize(rendered, { enhancers: [markEdits(rendered, { type: 'block' })] }),
    [rendered],
  );

  const gapRow = (i: number, title: string | null) => {
    const gap = gaps[i];
    if (gap?.hunk != null) return <Hunk key={`gap-${String(i)}`} hunk={gap.hunk} />;
    const count = gap?.count ?? 0;
    if (count === 0 && title === null) return null;
    return (
      <Decoration key={`gap-${String(i)}`} className="wfd-diff-gap">
        <div className="flex items-center gap-3 px-3 py-0.5 text-xs">
          {count > 0 && (
            <button
              type="button"
              className="inline-flex items-center gap-1 hover:underline"
              data-testid="diff-expand"
              onClick={() => {
                setExpanded(new Set([...expanded, i]));
              }}
            >
              <UnfoldVertical className="size-3.5" />
              展开 {count} 行未改动
            </button>
          )}
          {title !== null && <span className="wfd-diff-gap-title font-mono">{title}</span>}
        </div>
      </Decoration>
    );
  };

  return (
    <Diff
      viewType={viewType}
      diffType={diffTypes[status]}
      hunks={rendered}
      tokens={tokens}
      className="wfd-diff"
    >
      {() => [
        ...hunks.map((hunk, i) => (
          <Fragment key={hunkKey(hunk)}>
            {gapRow(i, renderHunkHeader === undefined ? hunkTitle(hunk) : null)}
            {renderHunkHeader !== undefined && (
              <Decoration className="wfd-diff-hunk-header">{renderHunkHeader(hunk, i)}</Decoration>
            )}
            <Hunk hunk={hunk} />
          </Fragment>
        )),
        <Fragment key="end">{gapRow(hunks.length, null)}</Fragment>,
      ]}
    </Diff>
  );
}

export function DiffCounts({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="font-mono text-xs" data-testid="diff-counts">
      <span className="wfd-diff-additions">+{additions}</span>{' '}
      <span className="wfd-diff-deletions">−{deletions}</span>
    </span>
  );
}

// 一个文件：可折叠的标题（路径、增删行数）与它的改动
export function DiffFileCard({
  file,
  viewType,
  source,
  actions,
  renderHunkHeader,
  className,
}: {
  file: DiffFile;
  viewType: ViewType;
  // 原文：给出时可以展开没有改动的行
  source?: string | undefined;
  // 标题右侧的内容
  actions?: ReactNode;
  renderHunkHeader?: ((hunk: HunkData, index: number) => ReactNode) | undefined;
  className?: string;
}) {
  const [open, setOpen] = useState(true);
  const Chevron = open ? ChevronDown : ChevronRight;
  const status = statusLabels[file.status];
  return (
    <section
      className={cn('overflow-hidden rounded-md border', className)}
      data-testid="diff-file"
      data-path={file.path}
    >
      <header className={cn('flex items-center gap-3 bg-muted/60 px-2 py-1.5', open && 'border-b')}>
        <button
          type="button"
          aria-expanded={open}
          className="flex min-w-0 items-center gap-1.5 text-left"
          onClick={() => {
            setOpen(!open);
          }}
        >
          <Chevron className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate font-mono text-xs font-medium">{file.path}</span>
        </button>
        {status !== null && <span className="text-xs text-muted-foreground">{status}</span>}
        <DiffCounts additions={file.additions} deletions={file.deletions} />
        {actions !== undefined && <div className="ml-auto flex items-center gap-2">{actions}</div>}
      </header>
      {open && (
        <DiffHunks
          hunks={file.hunks}
          status={file.status}
          viewType={viewType}
          source={source}
          renderHunkHeader={renderHunkHeader}
        />
      )}
    </section>
  );
}

// 若干文件的改动；sources 以路径为键给出原文
export function DiffView({
  files,
  viewType,
  sources = {},
  className,
}: {
  files: DiffFile[];
  viewType: ViewType;
  sources?: Record<string, string>;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-3', className)} data-testid="diff-view">
      {files.map((file) => (
        <DiffFileCard key={file.path} file={file} viewType={viewType} source={sources[file.path]} />
      ))}
    </div>
  );
}
