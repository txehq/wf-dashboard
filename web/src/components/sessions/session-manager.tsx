import { useQuery } from '@tanstack/react-query';
import { LoaderCircle } from 'lucide-react';
import { type ReactNode, useRef, useState } from 'react';
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

// The manage table below (Contracts 25.1): imported sessions, search (title, cwd, session id), filter by config,
// 50 per page. Changing the search, config, "Show archived" or view goes back to the first page and clears the
// selection; paging keeps it. With a selection, a row above the table says how many are selected (offering
// "Select all N" when the whole page is selected) and shows the operations from actions
export function SessionManager({
  engine,
  actions,
}: {
  engine: SessionEngine;
  // Operations on the selected sessions; done clears the selection
  actions: (targets: readonly SelectedSession[], done: () => void) => ReactNode;
}) {
  const [text, setText] = useState('');
  const [config, setConfig] = useState<string | null>(null);
  const [archived, setArchived] = useState(false);
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState<SessionSelection>(noSelection);
  const table = useRef<HTMLDivElement>(null);
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
  // With all selected: every id in this scope
  const allIds = useQuery({ ...sessionIdsQuery(scope), enabled: selection.kind === 'all' });
  const all = allIds.data?.ids.map((id) => ({ id, engine, archived }));
  const data = sessions.data;
  // Back to the last page when clearing, deleting or archiving leaves the current page out of range
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
        Failed to load sessions: {sessions.error.message}
      </p>
    ) : (
      <p className="py-8 text-center text-sm text-muted-foreground">Loading sessions…</p>
    );
  } else if (data.total === 0) {
    body = (
      <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed py-12 text-sm text-muted-foreground">
        {data.q !== '' ? (
          <>
            <p>No sessions match "{data.q}".</p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setText('');
              }}
            >
              Clear search
            </Button>
          </>
        ) : data.archived ? (
          <p>No archived sessions.</p>
        ) : (
          <p>No imported sessions yet. Check sessions above, then click Apply.</p>
        )}
      </div>
    );
  } else {
    body = (
      <div
        ref={table}
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
    <section aria-label="Managed sessions" className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <SearchBox
          className="w-80"
          value={text}
          onChange={setText}
          label="Search sessions"
          placeholder="Search titles, directories or session ids"
        />
        <label className="flex items-center gap-2 text-sm">
          <span className="sr-only">Filter by config</span>
          <select
            className="h-9 max-w-64 rounded-md border bg-background px-2 text-sm"
            value={config ?? ''}
            data-testid="session-config-filter"
            onChange={(event) => {
              setConfig(event.target.value === '' ? null : event.target.value);
              setPage(1);
            }}
          >
            <option value="">All configs</option>
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
            Show archived
          </label>
        )}
        {data !== undefined && (
          <Pager
            page={data.page}
            pageSize={SESSION_PAGE_SIZE}
            total={data.total}
            unit={data.total === 1 ? 'session' : 'sessions'}
            label="Session pages"
            onPage={setPage}
            testId="session-pager"
          />
        )}
        {sessions.isFetching && data !== undefined && (
          <LoaderCircle
            className="size-4 animate-spin text-muted-foreground"
            aria-label="Refreshing"
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
                Select all {data?.total}
              </Button>
            </>
          )}
          <span className="text-muted-foreground">·</span>
          <Button variant="link" size="sm" className="h-auto px-0" onClick={done}>
            Clear selection
          </Button>
          <span className="ml-auto flex flex-wrap items-center justify-end gap-2">
            {targets !== undefined ? (
              actions(targets, done)
            ) : allIds.isError ? (
              <span role="alert" className="text-destructive">
                Failed to load the ids of all sessions: {allIds.error.message}
              </span>
            ) : (
              <span className="text-muted-foreground">Loading the ids of all sessions…</span>
            )}
          </span>
        </div>
      )}
      {body}
      {/* The same page below the table; paging from here brings the top of the table back into view */}
      {data !== undefined && data.total > SESSION_PAGE_SIZE && (
        <div className="flex justify-end">
          <Pager
            page={data.page}
            pageSize={SESSION_PAGE_SIZE}
            total={data.total}
            unit="sessions"
            label="Session pages, bottom"
            onPage={(next) => {
              setPage(next);
              table.current?.scrollIntoView({ block: 'start' });
            }}
            testId="session-pager-bottom"
          />
        </div>
      )}
    </section>
  );
}
