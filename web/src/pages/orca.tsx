import { useQuery } from '@tanstack/react-query';
import { ChevronDown } from 'lucide-react';
import { Popover } from 'radix-ui';
import { useCallback, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { FullscreenArea, FullscreenButton, useFullscreen } from '@/components/fullscreen';
import { DRAWER_WIDTH, SideDrawer } from '@/components/live/side-drawer';
import { OrcaGraphView } from '@/components/orca/orca-graph';
import { EdgeMessages, NodeDetail } from '@/components/orca/orca-side';
import { Button } from '@/components/ui/button';
import { orcaGraphQuery, orcaSyncOnOpenQuery, useOrcaGraphEvents } from '@/lib/orca-api';
import { type GroupKey, groups } from '@/lib/orca-states';
import { type Filters, defaultFilters, projectsOf, shownGraph } from '@/lib/orca-view';
import { cn } from '@/lib/utils';

// The Orca topology page (Contracts 40.2): every session tied to Orca on this machine and its SSH hosts, grouped by
// project and worktree, with who dispatched whom and who talked to whom. The selection lives in the address (?node= or
// ?edge=), so "View in topology" in Live can open the page on a node; the filters are kept in localStorage

const FILTERS_KEY = 'wfd.orca.filters';
const allStates = groups.map((g) => g.key);

function readFilters(): Filters {
  const raw = localStorage.getItem(FILTERS_KEY);
  const defaults = defaultFilters([...allStates]);
  if (raw === null) return defaults;
  // Filters saved before a filter existed take its default
  const saved = JSON.parse(raw) as Partial<Filters>;
  return { projects: saved.projects ?? defaults.projects, states: saved.states ?? defaults.states };
}

function ProjectFilter({
  projects,
  selected,
  onChange,
}: {
  projects: { key: string; name: string; host: string | null }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const label =
    selected.length === 0
      ? 'All projects'
      : selected.length === 1
        ? (projects.find((p) => p.key === selected[0])?.name ?? '1 project')
        : `${String(selected.length)} projects`;
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="outline" size="sm" data-testid="orca-project-filter">
          {label}
          <ChevronDown />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 flex max-h-96 w-64 flex-col gap-1 overflow-y-auto rounded-md border bg-background p-2 shadow-md"
        >
          <button
            type="button"
            className="rounded px-2 py-1 text-left text-sm hover:bg-muted disabled:text-muted-foreground"
            disabled={selected.length === 0}
            onClick={() => {
              onChange([]);
            }}
          >
            All projects
          </button>
          {projects.map((p) => (
            <label
              key={p.key}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm hover:bg-muted"
            >
              <input
                type="checkbox"
                checked={selected.includes(p.key)}
                onChange={(e) => {
                  onChange(
                    e.target.checked ? [...selected, p.key] : selected.filter((k) => k !== p.key),
                  );
                }}
              />
              <span className="min-w-0 truncate">{p.name}</span>
              {p.host !== null && (
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">{p.host}</span>
              )}
            </label>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

function StateFilter({
  selected,
  onChange,
}: {
  selected: GroupKey[];
  onChange: (next: GroupKey[]) => void;
}) {
  return (
    <div className="flex items-center rounded-md border p-0.5" role="group" aria-label="States">
      {groups.map((g) => {
        const on = selected.includes(g.key);
        return (
          <button
            key={g.key}
            type="button"
            aria-pressed={on}
            className={cn(
              'rounded px-2 py-0.5 text-xs',
              on ? 'bg-secondary font-medium text-secondary-foreground' : 'text-muted-foreground',
            )}
            data-testid="orca-state-filter"
            data-state={g.key}
            onClick={() => {
              onChange(on ? selected.filter((k) => k !== g.key) : [...selected, g.key]);
            }}
          >
            {g.label}
          </button>
        );
      })}
    </div>
  );
}

export function OrcaPage() {
  useOrcaGraphEvents();
  const fullscreen = useFullscreen();
  const graph = useQuery(orcaGraphQuery);
  // The latest result shows at once; the sync started on opening brings changes through orca.updated
  const synced = useQuery(orcaSyncOnOpenQuery);
  const [params, setParams] = useSearchParams();
  const selectedNode = params.get('node');
  const selectedEdge = params.get('edge');
  // The node the page was opened on is brought into view once
  const [focus] = useState(selectedNode);
  const [filters, setFiltersState] = useState<Filters>(readFilters);
  const [toggled, setToggled] = useState<Set<string>>(() => new Set());
  const [unfolded, setUnfolded] = useState<Set<string>>(() => new Set());
  const [drawerWidth, setDrawerWidth] = useState(DRAWER_WIDTH);

  const setFilters = (next: Filters) => {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(next));
    setFiltersState(next);
  };
  const select = useCallback(
    (key: 'node' | 'edge' | null, id: string | null) => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete('node');
          next.delete('edge');
          if (key !== null && id !== null) next.set(key, id);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  const onSelectNode = useCallback(
    (id: string) => {
      select('node', id);
    },
    [select],
  );
  const onSelectEdge = useCallback(
    (id: string) => {
      select('edge', id);
    },
    [select],
  );
  const onToggleBox = useCallback((key: string) => {
    setToggled((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);
  const onUnfold = useCallback((key: string) => {
    setUnfolded((current) => new Set([...current, key]));
  }, []);

  const data = graph.data;
  const shown = useMemo(
    () =>
      data === undefined
        ? null
        : shownGraph(data, filters, { toggled, unfolded, selected: selectedNode }),
    [data, filters, toggled, unfolded, selectedNode],
  );
  const projects = useMemo(() => (data === undefined ? [] : projectsOf(data)), [data]);

  let body: React.ReactNode;
  if (data === undefined || shown === null) {
    body = graph.isError ? (
      <p role="alert" className="text-sm text-destructive">
        {graph.error.message}
      </p>
    ) : (
      <p className="text-sm text-muted-foreground">Loading Orca…</p>
    );
  } else if (!data.local.running && data.nodes.length === 0) {
    body = synced.isPending ? (
      <p className="text-sm text-muted-foreground">Reading Orca…</p>
    ) : (
      <p className="text-sm text-muted-foreground" data-testid="orca-not-running">
        Orca isn't running: {data.local.reason}
      </p>
    );
  } else {
    const node = selectedNode === null ? undefined : data.nodes.find((n) => n.id === selectedNode);
    const edge = selectedEdge === null ? undefined : shown.edges.find((e) => e.id === selectedEdge);
    const drawer =
      node !== undefined
        ? { title: 'Session', content: <NodeDetail node={node} /> }
        : edge !== undefined
          ? { title: 'Messages', content: <EdgeMessages edge={edge} graph={data} /> }
          : null;
    body = (
      <div className="flex min-h-0 flex-1 gap-3">
        <div className="min-h-0 min-w-0 flex-1 rounded-md border">
          {shown.nodes.length === 0 && shown.projects.every((p) => !p.collapsed) ? (
            <p className="flex size-full items-center justify-center text-sm text-muted-foreground">
              No sessions match the filters.
            </p>
          ) : (
            <OrcaGraphView
              projects={shown.projects}
              nodes={shown.nodes}
              edges={shown.edges}
              selected={selectedNode ?? selectedEdge}
              focus={focus}
              onSelectNode={onSelectNode}
              onSelectEdge={onSelectEdge}
              onToggleBox={onToggleBox}
              onUnfold={onUnfold}
            />
          )}
        </div>
        {drawer !== null && (
          <SideDrawer
            title={drawer.title}
            onClose={() => {
              select(null, null);
            }}
            width={drawerWidth}
            onResize={setDrawerWidth}
          >
            {drawer.content}
          </SideDrawer>
        )}
      </div>
    );
  }

  const sessions = data?.nodes.length ?? 0;
  const working = data?.nodes.filter((n) => n.state === 'working').length ?? 0;
  return (
    // Fixed to the window height (main has 2rem margins), the graph takes the rest
    <FullscreenArea
      active={fullscreen.active}
      className="flex h-[calc(100vh-4rem)] flex-col gap-3"
      activeClassName="gap-3 p-3"
      testId="orca-page"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-2 text-xl font-semibold">Orca</h1>
        {data !== undefined && (
          <>
            <ProjectFilter
              projects={projects}
              selected={filters.projects}
              onChange={(next) => {
                setFilters({ ...filters, projects: next });
              }}
            />
            <StateFilter
              selected={filters.states}
              onChange={(next) => {
                setFilters({ ...filters, states: next });
              }}
            />
            <span className="text-xs text-muted-foreground" data-testid="orca-counts">
              {sessions} {sessions === 1 ? 'session' : 'sessions'} · {working} working
            </span>
            {data.local.running ? null : (
              <span className="text-xs text-destructive" role="status">
                {data.local.reason}
              </span>
            )}
          </>
        )}
        <span className="ml-auto">
          <FullscreenButton active={fullscreen.active} onToggle={fullscreen.toggle} />
        </span>
      </div>
      {body}
    </FullscreenArea>
  );
}
