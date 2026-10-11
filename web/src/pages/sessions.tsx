import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { LoaderCircle, Search } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { SessionTable } from '@/components/sessions/session-table';
import { SourcePicker } from '@/components/sessions/source-picker';
import { Button } from '@/components/ui/button';
import { sessionsQuery, sourcesQuery, useSessionEvents, type Workflow } from '@/lib/sessions-api';

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

function SessionList() {
  const [text, setText] = useState('');
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const q = useDebounced(text.trim(), 250);
  const sources = useQuery(sourcesQuery);
  const sessions = useInfiniteQuery(sessionsQuery({ q, workflow }));
  const filtered = q !== '' || workflow !== null;
  // 多选的 session：一起分析（必须绑定同一个 variant，由分析表单检查）
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

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
            selected={selected}
            onToggle={(id) => {
              const next = new Set(selected);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              setSelected(next);
            }}
          />
          {sessions.hasNextPage && (
            <Button
              variant="outline"
              className="self-center"
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
        {selected.size > 0 && (
          <div className="ml-auto flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">已选 {selected.size} 个</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSelected(new Set());
              }}
            >
              清除
            </Button>
            <Button asChild size="sm">
              <Link to={`/analyses/new?sessions=${[...selected].join(',')}`}>分析这些 session</Link>
            </Button>
          </div>
        )}
      </div>
      {body}
    </section>
  );
}

export function SessionsPage() {
  useSessionEvents();
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Sessions</h1>
        <p className="text-sm text-muted-foreground">Claude Code session 的阶段图与请求明细。</p>
      </header>
      <SourcePicker />
      <SessionList />
    </div>
  );
}
