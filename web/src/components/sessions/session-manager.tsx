import { useQuery } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Pager } from '@/components/pager';
import { SearchBox } from '@/components/search-box';
import { SessionTable } from '@/components/sessions/session-table';
import { Button } from '@/components/ui/button';
import { configGroups } from '@/lib/config-groups';
import {
  importConfigsQuery,
  SESSION_PAGE_SIZE,
  type SessionEngine,
  sessionIdsQuery,
  sessionsQuery,
} from '@/lib/sessions-api';
import {
  isRowSelected,
  noSelection,
  pageState,
  type SelectedSession,
  selectedTargets,
  type SessionSelection,
  selectionSummary,
  toggledPage,
  toggledRow,
} from '@/lib/session-selection';
import { useDebounced } from '@/lib/use-debounced';

// 下面的管理表格（Contracts 25.1）：已导入的 session，搜索（标题、cwd、session id）、按配置筛选、每页 50 个。
// 切换搜索、配置、"显示已归档"或视图时回到第一页并清空选择；翻页时选择保留。
// 有选择时表格上方一行写出选了多少（本页全部选中时提供"选择全部 N 个"）与 actions 给出的操作
export function SessionManager({
  engine,
  actions,
}: {
  engine: SessionEngine;
  // 选中的 session 的操作；done 清空选择
  actions: (targets: readonly SelectedSession[], done: () => void) => ReactNode;
}) {
  const [text, setText] = useState('');
  const [config, setConfig] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState<SessionSelection>(noSelection);
  const [stateFor, setStateFor] = useState(engine);
  if (stateFor !== engine) {
    setStateFor(engine);
    setConfig(null);
    setArchived(false);
    setText('');
  }
  const q = useDebounced(text.trim(), 250);
  const scope = { engine, config, archived, q };
  const scopeKey = JSON.stringify(scope);
  const [scopeFor, setScopeFor] = useState(scopeKey);
  if (scopeFor !== scopeKey) {
    setScopeFor(scopeKey);
    setPage(1);
    setSelection(noSelection);
  }
  const configs = useQuery(importConfigsQuery(engine));
  const sessions = useQuery(sessionsQuery({ ...scope, page }));
  // 选中全部时这个范围内的全部 id
  const allIds = useQuery({ ...sessionIdsQuery(scope), enabled: selection.kind === 'all' });
  const all = allIds.data?.ids.map((id) => ({ id, engine, archived }));
  const data = sessions.data;
  // 清除、删除或归档后当前页超出范围时回到最后一页
  if (
    data !== undefined &&
    !sessions.isPlaceholderData &&
    page > 1 &&
    (page - 1) * SESSION_PAGE_SIZE >= data.total
  )
    setPage(Math.max(1, Math.ceil(data.total / SESSION_PAGE_SIZE)));
  const done = () => {
    setSelection(noSelection);
  };
  const pageRows = (data?.sessions ?? []).map((s) => ({
    id: s.id,
    engine: s.engine,
    archived: s.archivedAt !== null,
  }));
  const pageIds = pageRows.map((s) => s.id);
  const summary = selectionSummary(selection, pageIds, data?.total ?? 0);
  const targets = selectedTargets(selection, all);

  let body;
  if (data === undefined) {
    body = sessions.isError ? (
      <p role="alert" className="py-8 text-center text-sm text-destructive">
        加载 session 失败：{sessions.error.message}
      </p>
    ) : (
      <p className="py-8 text-center text-sm text-muted-foreground">正在加载 session…</p>
    );
  } else if (data.total === 0) {
    body = (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-12 text-sm text-muted-foreground">
        {data.q !== '' ? (
          <>
            <p>没有符合「{data.q}」的 session。</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setText('');
              }}
            >
              清除搜索
            </Button>
          </>
        ) : data.archived ? (
          <p>没有已归档的 session。</p>
        ) : (
          <p>还没有导入的 session。在上面勾选 session 后点"应用"。</p>
        )}
      </div>
    );
  } else {
    body = (
      <div
        className={sessions.isFetching ? 'opacity-70' : undefined}
        data-refreshing={sessions.isFetching}
      >
        <SessionTable
          sessions={data.sessions}
          isSelected={(id) => isRowSelected(selection, id)}
          disabled={selection.kind === 'all' && all === undefined}
          pageState={pageState(selection, pageIds)}
          onToggle={(s) => {
            setSelection(
              toggledRow(
                selection,
                { id: s.id, engine: s.engine, archived: s.archivedAt !== null },
                all ?? [],
              ),
            );
          }}
          onTogglePage={() => {
            setSelection(toggledPage(selection, pageRows));
          }}
        />
      </div>
    );
  }

  return (
    <section aria-label="管理的 session" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <SearchBox
          className="w-80"
          value={text}
          onChange={setText}
          label="搜索 session"
          placeholder="搜索标题、目录或 session id"
        />
        <label className="flex items-center gap-2 text-sm">
          <span className="sr-only">按配置筛选</span>
          <select
            className="h-9 max-w-64 rounded-md border bg-background px-2 text-sm"
            value={config ?? ''}
            data-testid="session-config-filter"
            onChange={(event) => {
              setConfig(event.target.value === '' ? null : event.target.value);
              setPage(1);
            }}
          >
            <option value="">全部配置</option>
            {configGroups(configs.data ?? []).map((g) => {
              const options = g.configs.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ));
              return g.workflow === null ? (
                options
              ) : (
                <optgroup key={g.workflow.id} label={g.workflow.name}>
                  {options}
                </optgroup>
              );
            })}
          </select>
        </label>
        {engine === 'codex' && (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              className="size-4 accent-foreground"
              checked={archived}
              data-testid="show-archived"
              onChange={(event) => {
                setArchived(event.target.checked);
                setPage(1);
              }}
            />
            显示已归档
          </label>
        )}
        {data !== undefined && (
          <Pager
            page={data.page}
            pageSize={SESSION_PAGE_SIZE}
            total={data.total}
            unit="个 session"
            label="session 的分页"
            onPage={setPage}
            testId="session-pager"
          />
        )}
        {sessions.isFetching && data !== undefined && (
          <LoaderCircle
            className="size-4 animate-spin text-muted-foreground"
            aria-label="正在刷新"
          />
        )}
      </div>
      {summary !== null && (
        <div
          className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 rounded-md bg-muted/60 px-3 py-1 text-sm"
          data-testid="selection-actions"
        >
          <span data-testid="selection-summary">{summary.text}</span>
          {summary.offerAll && (
            <>
              <span className="text-muted-foreground">·</span>
              <Button
                variant="link"
                size="sm"
                className="h-auto px-0"
                data-testid="select-all"
                onClick={() => {
                  setSelection({ kind: 'all' });
                }}
              >
                选择全部 {data?.total} 个
              </Button>
            </>
          )}
          <span className="text-muted-foreground">·</span>
          <Button variant="link" size="sm" className="h-auto px-0" onClick={done}>
            取消选择
          </Button>
          <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {targets !== undefined ? (
              actions(targets, done)
            ) : allIds.isError ? (
              <span role="alert" className="text-destructive">
                读取全部 session 的 id 失败：{allIds.error.message}
              </span>
            ) : (
              <span className="text-muted-foreground">正在读取全部 session 的 id…</span>
            )}
          </span>
        </div>
      )}
      {body}
    </section>
  );
}
