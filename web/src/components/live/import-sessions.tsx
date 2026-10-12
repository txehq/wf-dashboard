import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatDateTime } from '@/lib/format';
import { importLive, type LiveSummary } from '@/lib/live-api';
import { sessionsQuery } from '@/lib/sessions-api';

// "导入本机 session"（Contracts 14.5）：列出 dashboard 已导入的全部 session（与 Sessions 列表相同的数据），
// 按标题、cwd、session id 搜索，多选；已在交互区的不可选
function ImportForm({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (items: LiveSummary[]) => void;
}) {
  const client = useQueryClient();
  const [q, setQ] = useState('');
  const [chosen, setChosen] = useState<string[]>([]);
  const sessions = useInfiniteQuery(sessionsQuery({ q: q.trim(), workflow: null }));
  const importing = useMutation({
    mutationFn: () => importLive(chosen),
    onSuccess: async (items) => {
      await client.invalidateQueries({ queryKey: ['live'] });
      await client.invalidateQueries({ queryKey: ['sessions'] });
      onImported(items);
    },
  });
  const rows = sessions.data?.pages.flatMap((p) => p.sessions) ?? [];
  return (
    <div className="flex min-h-0 flex-col gap-3">
      <Input
        aria-label="搜索 session"
        placeholder="搜索标题、目录或 session id"
        value={q}
        onChange={(event) => {
          setQ(event.target.value);
        }}
      />
      <ul
        className="flex max-h-[24rem] min-h-0 flex-col gap-1 overflow-y-auto"
        data-testid="import-list"
      >
        {sessions.isPending && <li className="text-sm text-muted-foreground">加载中…</li>}
        {sessions.isError && (
          <li role="alert" className="text-sm text-destructive">
            {sessions.error.message}
          </li>
        )}
        {sessions.data !== undefined && rows.length === 0 && (
          <li className="text-sm text-muted-foreground">没有符合的 session。</li>
        )}
        {rows.map((s) => {
          const taken = s.liveId !== null;
          return (
            <li key={s.id}>
              <label
                className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm has-disabled:opacity-60"
                data-session={s.id}
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  disabled={taken}
                  checked={chosen.includes(s.id)}
                  onChange={() => {
                    setChosen(
                      chosen.includes(s.id) ? chosen.filter((x) => x !== s.id) : [...chosen, s.id],
                    );
                  }}
                />
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="line-clamp-2 font-medium">{s.title ?? '（没有用户消息）'}</span>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {s.cwd ?? '—'} · {s.id.slice(0, 8)} · {formatDateTime(s.startedAt)}
                  </span>
                  {taken && (
                    <span className="text-xs text-muted-foreground" data-testid="import-taken">
                      已在交互区
                    </span>
                  )}
                </span>
              </label>
            </li>
          );
        })}
        {sessions.hasNextPage && (
          <li>
            <Button
              variant="ghost"
              size="sm"
              disabled={sessions.isFetchingNextPage}
              onClick={() => {
                void sessions.fetchNextPage();
              }}
            >
              加载更多
            </Button>
          </li>
        )}
      </ul>
      {importing.isError && (
        <p role="alert" className="text-sm text-destructive">
          {importing.error.message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="outline" onClick={onClose}>
          取消
        </Button>
        <Button
          data-testid="import-confirm"
          disabled={chosen.length === 0 || importing.isPending}
          onClick={() => {
            importing.mutate();
          }}
        >
          <Download />
          {importing.isPending ? '正在导入…' : `导入 ${String(chosen.length)} 个`}
        </Button>
      </div>
    </div>
  );
}

export function ImportSessionsButton({
  onImported,
}: {
  onImported: (items: LiveSummary[]) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        data-testid="import-open"
        onClick={() => {
          setOpen(true);
        }}
      >
        <Download />
        导入本机 session
      </Button>
      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div
            role="dialog"
            aria-modal="true"
            aria-label="导入本机 session"
            className="flex max-h-[90vh] w-[40rem] max-w-[90vw] flex-col gap-4 rounded-lg border bg-background p-5 shadow-lg"
            data-testid="import-dialog"
          >
            <h2 className="text-base font-semibold">导入本机 session</h2>
            <ImportForm
              onClose={() => {
                setOpen(false);
              }}
              onImported={(items) => {
                setOpen(false);
                onImported(items);
              }}
            />
          </div>
        </div>
      )}
    </>
  );
}
