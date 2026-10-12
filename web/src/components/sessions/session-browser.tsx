import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { LoaderCircle, Search } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { SessionTable, type SessionTableMode } from '@/components/sessions/session-table';
import { Button } from '@/components/ui/button';
import {
  type SessionSummary,
  sessionsQuery,
  sourcesQuery,
  type Workflow,
} from '@/lib/sessions-api';

const workflowOptions: { value: Workflow | null; label: string }[] = [
  { value: null, label: '全部' },
  { value: 'lfg', label: '/lfg' },
  { value: 'ic', label: '/ic' },
];

function useDebounced(value: string, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [value, ms]);
  return debounced;
}

// 勾选来源目录中的 session 列表：搜索、按 workflow 筛选、多选与"加载更多"。
// Sessions 页面与"导入本机 session"选择框共用（Contracts 14.5）；actions 放在工具栏右侧
export function SessionBrowser({
  mode,
  selected,
  isSelectable,
  onToggle,
  actions,
}: {
  mode: SessionTableMode;
  selected: ReadonlySet<string>;
  isSelectable: (session: SessionSummary) => boolean;
  onToggle: (id: string) => void;
  actions?: ReactNode;
}) {
  const [text, setText] = useState('');
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const q = useDebounced(text.trim(), 250);
  const sources = useQuery(sourcesQuery);
  const sessions = useInfiniteQuery(sessionsQuery({ q, workflow }));
  const filtered = q !== '' || workflow !== null;

  let body;
  if (sessions.isPending) {
    body = <p className="py-8 text-center text-sm text-muted-foreground">正在加载 session…</p>;
  } else if (sessions.isError) {
    body = (
      <p role="alert" className="py-8 text-center text-sm text-destructive">
        加载 session 失败：{sessions.error.message}
      </p>
    );
  } else {
    const rows = sessions.data.pages.flatMap((p) => p.sessions);
    if (rows.length === 0) {
      const noneChecked = sources.data?.every((s) => !s.checked) ?? false;
      body = (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-12 text-sm text-muted-foreground">
          {filtered ? (
            <>
              <p>没有符合条件的 session。</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setText('');
                  setWorkflow(null);
                }}
              >
                清除筛选
              </Button>
            </>
          ) : noneChecked ? (
            <p>在上方勾选来源目录后，这里会列出其中的 session。</p>
          ) : (
            <p>勾选的目录中还没有 session。</p>
          )}
        </div>
      );
    } else {
      body = (
        <div className={`flex flex-col gap-3 ${sessions.isFetching ? 'opacity-70' : ''}`}>
          <SessionTable
            sessions={rows}
            mode={mode}
            selected={selected}
            isSelectable={isSelectable}
            onToggle={onToggle}
          />
          {sessions.hasNextPage && (
            <Button
              variant="outline"
              className="self-center"
              data-testid="load-more"
              disabled={sessions.isFetchingNextPage}
              onClick={() => {
                void sessions.fetchNextPage();
              }}
            >
              {sessions.isFetchingNextPage ? '正在加载…' : '加载更多'}
            </Button>
          )}
        </div>
      );
    }
  }

  return (
    <section aria-label="session 列表" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="relative w-80">
          <span className="sr-only">搜索 session</span>
          <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <input
            type="search"
            value={text}
            placeholder="搜索标题、目录或 session id"
            className="h-9 w-full rounded-md border bg-background pr-3 pl-8 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
        </label>
        <div
          role="radiogroup"
          aria-label="按 workflow 筛选"
          className="flex rounded-md border p-0.5"
        >
          {workflowOptions.map((option) => (
            <button
              key={option.label}
              type="button"
              role="radio"
              aria-checked={workflow === option.value}
              className="rounded px-3 py-1 text-sm aria-checked:bg-foreground aria-checked:text-background"
              onClick={() => {
                setWorkflow(option.value);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
        {sessions.isFetching && !sessions.isPending && (
          <LoaderCircle
            className="size-4 animate-spin text-muted-foreground"
            aria-label="正在刷新"
          />
        )}
        {actions}
      </div>
      {body}
    </section>
  );
}
