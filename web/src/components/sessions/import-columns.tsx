import { useQuery } from '@tanstack/react-query';
import { Server } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Pager } from '@/components/pager';
import { SearchBox } from '@/components/search-box';
import { configGroups, matchesConfig } from '@/lib/config-groups';
import { formatBytes, formatDateTime, formatInteger, formatNoun } from '@/lib/format';
import {
  changeKind,
  type ImportChanges,
  type ImportMode,
  type ImportPlace,
  isChecked,
  isSelectable,
  pageAllChecked,
  projectCountText,
  withChecked,
} from '@/lib/import-changes';
import {
  type DiskSession,
  diskSessionsQuery,
  IMPORT_PAGE_SIZE,
  type ImportConfig,
  importConfigsQuery,
  importProjectsQuery,
  type SessionEngine,
} from '@/lib/sessions-api';
import { useDebounced } from '@/lib/use-debounced';
import { cn } from '@/lib/utils';

// The selected item: light gray background, bold
const itemClass =
  'flex h-8 w-full min-w-0 shrink-0 items-center gap-2 rounded px-2 text-left text-sm hover:bg-muted/60 aria-[current=true]:bg-muted aria-[current=true]:font-semibold';

// In Live the second column shows no changes
const noChanges: ImportChanges = new Map();

function Count({ children }: { children: ReactNode }) {
  return (
    <span className="ml-auto shrink-0 pl-2 text-xs text-muted-foreground tabular-nums">
      {children}
    </span>
  );
}

function Hint({ children }: { children: ReactNode }) {
  return <p className="px-2 py-3 text-sm text-muted-foreground">{children}</p>;
}

// One column: search box on top, a list scrolling within a fixed height, count and pager at the bottom.
// busy: after paging or searching the new page has not arrived yet, so list and pager still show the previous data
function Column({
  label,
  header,
  footer,
  children,
  testId,
  busy = false,
}: {
  label: string;
  header: ReactNode;
  footer: ReactNode;
  children: ReactNode;
  testId: string;
  busy?: boolean;
}) {
  return (
    <section
      aria-label={label}
      aria-busy={busy}
      className="flex min-h-0 min-w-0 flex-col border-r last:border-r-0"
      data-testid={testId}
    >
      <div className="flex items-center gap-2 border-b px-2 py-1.5">{header}</div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-1">{children}</div>
      <div className="flex h-8 shrink-0 items-center border-t px-2">{footer}</div>
    </section>
  );
}

// Back to the first page when the search changes
function useSearch() {
  const [text, setText] = useState('');
  const [page, setPage] = useState(1);
  const q = useDebounced(text.trim(), 250);
  const [pageFor, setPageFor] = useState(q);
  if (pageFor !== q) {
    setPageFor(q);
    setPage(1);
  }
  return { text, setText, q, page, setPage };
}

// Picking in a new analysis (Contracts 27): the third column's checks are the selected sessions, held by the
// page; the first column is locked to the config of the selection, and configs that cannot be picked are
// grayed out with the reason on hover
export interface ColumnsPick {
  has: (s: DiskSession) => boolean;
  onChange: (list: DiskSession[], want: boolean, place: ImportPlace & { project: string }) => void;
  blocked: (c: ImportConfig) => string | null;
  // Config of the selection; after the selection is cleared the first column stays on that config
  config: string | null;
}

// className can change height and column widths (taller and narrower in a new analysis)
type ColumnsProps = { engine: SessionEngine; className?: string } & (
  | {
      mode: ImportMode;
      // Staged changes by file; kept across pages, projects and configs
      changes: ImportChanges;
      onChanges: (next: ImportChanges) => void;
    }
  | { mode: 'pick'; pick: ColumnsPick }
);

// The three columns (Contracts 25.1): configs, the projects of the chosen config, and that project's sessions
// on disk. Fixed height, each column scrolls and searches on its own, 50 per page in columns two and three.
// Reads only metadata on disk; the caller applies the changes
export function ImportColumns(props: ColumnsProps) {
  const { engine } = props;
  const [configText, setConfigText] = useState('');
  const [config, setConfig] = useState<string | null>(null);
  const [project, setProject] = useState<{ cwd: string; name: string } | null>(null);
  const projectSearch = useSearch();
  const sessionSearch = useSearch();
  // Back to the first config when the view switches
  const [stateFor, setStateFor] = useState(engine);
  if (stateFor !== engine) {
    setStateFor(engine);
    setConfig(null);
    setProject(null);
    setConfigText('');
    projectSearch.setText('');
    sessionSearch.setText('');
  }

  const configs = useQuery(importConfigsQuery(engine));
  // The first config until one is clicked
  const activeConfig = config ?? configs.data?.[0]?.id ?? null;
  // New analysis: lock to the config of the selection (if already on it, only record it; project unchanged)
  const lockedConfig = props.mode === 'pick' ? props.pick.config : null;
  if (lockedConfig !== null && config !== lockedConfig) {
    setConfig(lockedConfig);
    if (activeConfig !== lockedConfig) {
      setProject(null);
      projectSearch.setText('');
    }
  }
  const projects = useQuery({
    ...importProjectsQuery(engine, activeConfig ?? '', projectSearch.q, projectSearch.page),
    enabled: activeConfig !== null,
  });
  const sessions = useQuery({
    ...diskSessionsQuery(
      engine,
      activeConfig ?? '',
      project?.cwd ?? '',
      sessionSearch.q,
      sessionSearch.page,
    ),
    enabled: activeConfig !== null && project !== null,
  });

  const chooseConfig = (id: string) => {
    if (id === activeConfig) return;
    setConfig(id);
    setProject(null);
    projectSearch.setText('');
    projectSearch.setPage(1);
  };
  const chooseProject = (next: { cwd: string; name: string }) => {
    if (next.cwd === project?.cwd) return;
    setProject(next);
    sessionSearch.setText('');
    sessionSearch.setPage(1);
  };

  const pageSessions = sessions.data?.sessions ?? [];
  const place =
    activeConfig !== null && project !== null ? { config: activeConfig, cwd: project.cwd } : null;
  const { mode } = props;
  const changes = props.mode === 'pick' ? noChanges : props.changes;
  // Check state and changes: staged changes in Sessions and Live, the selected sessions in a new analysis
  const select =
    props.mode === 'pick'
      ? {
          checked: props.pick.has,
          selectable: () => true,
          allChecked: (list: DiskSession[]) => list.length > 0 && list.every(props.pick.has),
          set: (list: DiskSession[], want: boolean) => {
            if (place !== null && project !== null)
              props.pick.onChange(list, want, { ...place, project: project.name });
          },
        }
      : {
          checked: (s: DiskSession) => isChecked(props.mode, props.changes, s),
          selectable: (s: DiskSession) => isSelectable(props.mode, s),
          allChecked: (list: DiskSession[]) => pageAllChecked(props.mode, props.changes, list),
          set: (list: DiskSession[], want: boolean) => {
            if (place !== null)
              props.onChanges(withChecked(props.mode, props.changes, list, want, place));
          },
        };
  const checked = select.checked;
  const selectable = select.selectable;
  const toggle = (s: DiskSession) => {
    select.set([s], !checked(s));
  };
  const pageSelectable = pageSessions.filter(selectable);
  const allChecked = select.allChecked(pageSelectable);
  const toggleAll = () => {
    select.set(pageSelectable, !allChecked);
  };

  const shownConfigs = (configs.data ?? []).filter((c) => matchesConfig(c, configText));
  // Variants in a group are indented one level below the group title
  const configButton = (c: ImportConfig) => {
    // Unreachable hosts are grayed out, with ssh's original error on hover (Contracts 31.6)
    const blocked = c.error ?? (props.mode === 'pick' ? props.pick.blocked(c) : null);
    return (
      <button
        key={c.id}
        type="button"
        className={cn(
          itemClass,
          c.workflow !== null && 'pl-4',
          blocked !== null &&
            'cursor-not-allowed text-muted-foreground opacity-60 hover:bg-transparent',
        )}
        aria-current={c.id === activeConfig}
        aria-disabled={blocked !== null}
        title={blocked ?? (c.workflow === null ? c.label : `${c.label} (${c.workflow.name})`)}
        data-testid="import-config"
        data-config={c.id}
        onClick={() => {
          if (blocked === null) chooseConfig(c.id);
        }}
      >
        {c.hostId !== null && <Server className="size-3.5 shrink-0" aria-label="SSH host" />}
        <span className="truncate">{c.label}</span>
        <Count>{formatInteger(c.sessionCount)}</Count>
      </button>
    );
  };

  return (
    <div
      className={cn(
        'grid h-72 grid-cols-[minmax(11rem,1fr)_minmax(14rem,1.4fr)_minmax(22rem,2.6fr)] rounded-lg border',
        props.className,
      )}
      data-testid="import-columns"
    >
      <Column
        label="Configs"
        testId="import-configs"
        header={
          <SearchBox
            className="min-w-0 flex-1"
            value={configText}
            onChange={setConfigText}
            label="Search configs"
            placeholder="Search configs"
          />
        }
        footer={
          configs.data !== undefined && (
            <span className="text-sm text-muted-foreground">
              {formatNoun(configs.data.length, 'config')}
            </span>
          )
        }
      >
        {configs.isError ? (
          <p role="alert" className="px-2 py-3 text-sm text-destructive">
            Failed to load configs: {configs.error.message}
          </p>
        ) : configs.data === undefined ? (
          <Hint>Loading configs…</Hint>
        ) : shownConfigs.length === 0 ? (
          <Hint>No configs match "{configText.trim()}".</Hint>
        ) : (
          configGroups(shownConfigs).map((g) =>
            g.workflow === null ? (
              g.configs.map(configButton)
            ) : (
              <div
                key={g.workflow.id}
                role="group"
                aria-label={g.workflow.name}
                className="flex shrink-0 flex-col"
                data-testid="import-config-group"
              >
                <div className="truncate px-2 pt-2 pb-0.5 text-xs font-medium text-muted-foreground">
                  {g.workflow.name}
                </div>
                {g.configs.map(configButton)}
              </div>
            ),
          )
        )}
      </Column>

      <Column
        label="Projects"
        testId="import-projects"
        busy={projects.isPlaceholderData}
        header={
          <SearchBox
            className="min-w-0 flex-1"
            value={projectSearch.text}
            onChange={projectSearch.setText}
            label="Search projects"
            placeholder="Search projects or paths"
          />
        }
        footer={
          projects.data !== undefined && (
            <Pager
              page={projects.data.page}
              pageSize={IMPORT_PAGE_SIZE}
              total={projects.data.total}
              unit={projects.data.total === 1 ? 'project' : 'projects'}
              label="Project pages"
              onPage={projectSearch.setPage}
              testId="project-pager"
            />
          )
        }
      >
        {activeConfig === null ? (
          <Hint>No configs.</Hint>
        ) : projects.isError ? (
          <p role="alert" className="px-2 py-3 text-sm text-destructive">
            Failed to load projects: {projects.error.message}
          </p>
        ) : projects.data === undefined ? (
          <Hint>Loading projects…</Hint>
        ) : projects.data.total === 0 ? (
          <Hint>
            {projects.data.q === ''
              ? 'No sessions in this config yet.'
              : `No projects match "${projects.data.q}".`}
          </Hint>
        ) : (
          <div className={cn('flex flex-col', projects.isPlaceholderData && 'opacity-70')}>
            {projects.data.projects.map((p) => (
              <button
                key={p.cwd}
                type="button"
                className={itemClass}
                aria-current={p.cwd === project?.cwd}
                title={p.cwd}
                data-testid="import-project"
                data-cwd={p.cwd}
                onClick={() => {
                  chooseProject(p);
                }}
              >
                <span className="truncate font-mono text-xs">{p.name}</span>
                <Count>
                  {projectCountText(mode === 'manage' ? changes : noChanges, activeConfig, p)}
                </Count>
              </button>
            ))}
          </div>
        )}
      </Column>

      <Column
        label="Sessions on disk"
        testId="import-sessions"
        busy={sessions.isPlaceholderData}
        header={
          <>
            <label className="flex shrink-0 items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-foreground"
                checked={allChecked}
                disabled={pageSelectable.length === 0}
                data-testid="import-select-page"
                onChange={toggleAll}
              />
              Select all
            </label>
            <SearchBox
              className="min-w-0 flex-1"
              value={sessionSearch.text}
              onChange={sessionSearch.setText}
              label="Search sessions on disk"
              placeholder="Search titles or session ids"
            />
          </>
        }
        footer={
          sessions.data !== undefined && (
            <Pager
              page={sessions.data.page}
              pageSize={IMPORT_PAGE_SIZE}
              total={sessions.data.total}
              unit={sessions.data.total === 1 ? 'session' : 'sessions'}
              label="Pages of sessions on disk"
              onPage={sessionSearch.setPage}
              testId="disk-pager"
            />
          )
        }
      >
        {project === null ? (
          <Hint>Choose a project to list its sessions.</Hint>
        ) : sessions.isError ? (
          <p role="alert" className="px-2 py-3 text-sm text-destructive">
            Failed to load sessions: {sessions.error.message}
          </p>
        ) : sessions.data === undefined ? (
          <Hint>Loading sessions in {project.name}…</Hint>
        ) : sessions.data.total === 0 ? (
          <Hint>No sessions match "{sessions.data.q}".</Hint>
        ) : (
          <div className={cn('flex flex-col', sessions.isPlaceholderData && 'opacity-70')}>
            {pageSessions.map((s) => {
              const can = selectable(s);
              const taken = mode === 'live' && !can;
              const change = changes.get(s.file);
              const kind = mode === 'manage' && change !== undefined ? changeKind(change) : null;
              const title = s.title ?? '(no user message)';
              return (
                <label
                  key={s.file}
                  className={cn(
                    'flex h-8 shrink-0 items-center gap-2 rounded border-l-2 border-transparent px-2 text-sm hover:bg-muted/60',
                    !can && 'text-muted-foreground',
                    kind === 'import' && 'border-emerald-600 bg-emerald-50 dark:bg-emerald-950/40',
                    kind === 'clear' && 'border-destructive bg-red-50 dark:bg-red-950/40',
                  )}
                  title={`${title}\n${s.id}`}
                  data-testid="disk-session"
                  data-session={s.id}
                  data-change={kind ?? undefined}
                >
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 accent-foreground"
                    aria-label={`Select session ${s.id.slice(0, 8)}`}
                    checked={checked(s)}
                    disabled={!can}
                    onChange={() => {
                      toggle(s);
                    }}
                  />
                  {kind !== null && (
                    <span
                      className={cn(
                        'shrink-0 text-xs font-medium',
                        kind === 'import'
                          ? 'text-emerald-700 dark:text-emerald-400'
                          : 'text-destructive',
                      )}
                      data-testid="disk-change"
                    >
                      {kind === 'import' ? '+ Import' : '− Clear'}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{title}</span>
                  {kind === null && (s.imported || taken) && (
                    <span
                      className="shrink-0 rounded border px-1.5 text-xs text-muted-foreground"
                      data-testid={taken ? 'import-taken' : 'disk-imported'}
                    >
                      {taken ? 'In workspace' : 'Imported'}
                    </span>
                  )}
                  <span className="w-24 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                    {formatDateTime(s.startedAt)}
                  </span>
                  {/* Columns are narrower in a new analysis: hide the size in narrow windows to leave room for the title */}
                  <span
                    className={cn(
                      'w-16 shrink-0 text-right text-xs text-muted-foreground tabular-nums',
                      props.mode === 'pick' && 'hidden 2xl:inline',
                    )}
                  >
                    {formatBytes(s.size)}
                  </span>
                </label>
              );
            })}
          </div>
        )}
      </Column>
    </div>
  );
}
