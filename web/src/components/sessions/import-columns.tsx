import { useQuery } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { Pager } from '@/components/pager';
import { SearchBox } from '@/components/search-box';
import { configGroups, matchesConfig } from '@/lib/config-groups';
import { formatBytes, formatDateTime, formatInteger } from '@/lib/format';
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

// 选中的一项：浅灰底、加粗
const itemClass =
  'flex h-8 w-full min-w-0 shrink-0 items-center gap-2 rounded px-2 text-left text-sm hover:bg-muted/60 aria-[current=true]:bg-muted aria-[current=true]:font-semibold';

// live 中第二列不显示改动
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

// 一列：顶部是搜索框，中间的列表在固定高度内滚动，底部是数目与分页。busy：翻页或搜索后新的一页还没有到达，
// 列表与分页都还是上一次的数据
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

// 搜索改变时回到第一页
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

// 新建分析中的选择（Contracts 27）：第三列的勾选即已选的 session，由页面持有；第一列选定已选的所在的配置，
// 不能点选的配置灰显并悬停说明原因
export interface ColumnsPick {
  has: (s: DiskSession) => boolean;
  onChange: (list: DiskSession[], want: boolean, place: ImportPlace & { project: string }) => void;
  blocked: (c: ImportConfig) => string | null;
  // 已选的所在的配置；清空已选后第一列停在原来的配置
  config: string | null;
}

// 高度与列宽可以由 className 改（新建分析中三列更高、更窄）
type ColumnsProps = { engine: SessionEngine; className?: string } & (
  | {
      mode: ImportMode;
      // 暂存的改动，按文件；翻页、换项目、换配置时保留
      changes: ImportChanges;
      onChanges: (next: ImportChanges) => void;
    }
  | { mode: 'pick'; pick: ColumnsPick }
);

// 上面的三列（Contracts 25.1）：第一列配置，第二列这个配置下的项目，第三列这个项目在磁盘上的 session。
// 三列高度固定、各自滚动与搜索，第二、三列每页 50 个。只读磁盘上的元数据，改动由调用者应用
export function ImportColumns(props: ColumnsProps) {
  const { engine } = props;
  const [configText, setConfigText] = useState('');
  const [config, setConfig] = useState<string | null>(null);
  const [project, setProject] = useState<{ cwd: string; name: string } | null>(null);
  const projectSearch = useSearch();
  const sessionSearch = useSearch();
  // 切换视图时回到第一个配置
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
  // 还没有点选时为第一个配置
  const activeConfig = config ?? configs.data?.[0]?.id ?? null;
  // 新建分析：选定已选的所在的配置（已经是它时只记下，项目不变）
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
  // 勾选的状态与改动：Sessions 与 Live 中是暂存的改动，新建分析中是已选的 session
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
  // 组内的 variant 比组的标题缩进一级
  const configButton = (c: ImportConfig) => {
    const blocked = props.mode === 'pick' ? props.pick.blocked(c) : null;
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
        title={blocked ?? (c.workflow === null ? c.label : `${c.label}（${c.workflow.name}）`)}
        data-testid="import-config"
        data-config={c.id}
        onClick={() => {
          if (blocked === null) chooseConfig(c.id);
        }}
      >
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
        label="配置"
        testId="import-configs"
        header={
          <SearchBox
            className="min-w-0 flex-1"
            value={configText}
            onChange={setConfigText}
            label="搜索配置"
            placeholder="搜索配置"
          />
        }
        footer={
          configs.data !== undefined && (
            <span className="text-sm text-muted-foreground">
              共 {formatInteger(configs.data.length)} 个配置
            </span>
          )
        }
      >
        {configs.isError ? (
          <p role="alert" className="px-2 py-3 text-sm text-destructive">
            读取配置失败：{configs.error.message}
          </p>
        ) : configs.data === undefined ? (
          <Hint>正在读取配置…</Hint>
        ) : shownConfigs.length === 0 ? (
          <Hint>没有符合「{configText.trim()}」的配置。</Hint>
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
        label="项目"
        testId="import-projects"
        busy={projects.isPlaceholderData}
        header={
          <SearchBox
            className="min-w-0 flex-1"
            value={projectSearch.text}
            onChange={projectSearch.setText}
            label="搜索项目"
            placeholder="搜索项目或路径"
          />
        }
        footer={
          projects.data !== undefined && (
            <Pager
              page={projects.data.page}
              pageSize={IMPORT_PAGE_SIZE}
              total={projects.data.total}
              unit="个项目"
              label="项目的分页"
              onPage={projectSearch.setPage}
              testId="project-pager"
            />
          )
        }
      >
        {activeConfig === null ? (
          <Hint>没有配置。</Hint>
        ) : projects.isError ? (
          <p role="alert" className="px-2 py-3 text-sm text-destructive">
            读取项目失败：{projects.error.message}
          </p>
        ) : projects.data === undefined ? (
          <Hint>正在读取项目…</Hint>
        ) : projects.data.total === 0 ? (
          <Hint>
            {projects.data.q === ''
              ? '这个配置中还没有 session。'
              : `没有符合「${projects.data.q}」的项目。`}
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
        label="磁盘上的 session"
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
              全选
            </label>
            <SearchBox
              className="min-w-0 flex-1"
              value={sessionSearch.text}
              onChange={sessionSearch.setText}
              label="搜索磁盘上的 session"
              placeholder="搜索标题或 session id"
            />
          </>
        }
        footer={
          sessions.data !== undefined && (
            <Pager
              page={sessions.data.page}
              pageSize={IMPORT_PAGE_SIZE}
              total={sessions.data.total}
              unit="个 session"
              label="磁盘上的 session 的分页"
              onPage={sessionSearch.setPage}
              testId="disk-pager"
            />
          )
        }
      >
        {project === null ? (
          <Hint>点一个项目，列出其中的 session。</Hint>
        ) : sessions.isError ? (
          <p role="alert" className="px-2 py-3 text-sm text-destructive">
            读取 session 失败：{sessions.error.message}
          </p>
        ) : sessions.data === undefined ? (
          <Hint>正在读取 {project.name} 中的 session…</Hint>
        ) : sessions.data.total === 0 ? (
          <Hint>没有符合「{sessions.data.q}」的 session。</Hint>
        ) : (
          <div className={cn('flex flex-col', sessions.isPlaceholderData && 'opacity-70')}>
            {pageSessions.map((s) => {
              const can = selectable(s);
              const taken = mode === 'live' && !can;
              const change = changes.get(s.file);
              const kind = mode === 'manage' && change !== undefined ? changeKind(change) : null;
              const title = s.title ?? '（没有用户消息）';
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
                    aria-label={`勾选 session ${s.id.slice(0, 8)}`}
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
                      {kind === 'import' ? '+ 导入' : '− 清除'}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate">{title}</span>
                  {kind === null && (s.imported || taken) && (
                    <span
                      className="shrink-0 rounded border px-1.5 text-xs text-muted-foreground"
                      data-testid={taken ? 'import-taken' : 'disk-imported'}
                    >
                      {taken ? '已在交互区' : '已导入'}
                    </span>
                  )}
                  <span className="w-24 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
                    {formatDateTime(s.startedAt)}
                  </span>
                  {/* 新建分析中三列更窄：窄的窗口中不显示大小，把宽度留给标题 */}
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
