import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { OpenInLiveButton } from '@/components/live/open-in-live';
import { PurposeBadge, WorkflowBadges } from '@/components/sessions/workflow-badges';
import { tableBindingNote } from '@/lib/analyses-api';
import {
  durationBetween,
  formatCount,
  formatDateTime,
  formatDuration,
  formatInteger,
  formatUsd,
  totalTokens,
} from '@/lib/format';
import type { SessionSummary } from '@/lib/sessions-api';
import { cn } from '@/lib/utils';

// 价格表中没有这个模型时只记 token（Contracts 25.2）
export const UNPRICED = '价格表中没有这个 session 用的模型，只记 token';
// 本机配置的 session 不绑定 variant（Contracts 25.4）
export const LOCAL_NO_BINDING = '本机配置的 session 不绑定 variant';

type ColumnKey =
  | 'select'
  | 'title'
  | 'cwd'
  | 'time'
  | 'requests'
  | 'tokens'
  | 'cost'
  | 'workflow'
  | 'variant'
  | 'live';

// 表格固定宽度（Contracts 18.1）。内容宽度可以预知的列（勾选框、时间、数字、workflow 标记、variant、Live 图标）
// 为固定宽度，标题 23%、目录 11%（合计不到 35%，标题是最宽的一列）；表格更宽时多出的宽度由浏览器按比例分给各列。
// run 的 session 在 variant 一列的第二行显示 run（run 的 session 绑定的就是 run 所用的 variant），Live 交互的不写绑定种类
// （28.5）；所有行都为空的列不显示
const columns: { key: ColumnKey; label: string; width: string; right?: boolean }[] = [
  { key: 'select', label: '选择', width: '2.25rem' },
  { key: 'title', label: '标题', width: '23%' },
  { key: 'cwd', label: '目录', width: '11%' },
  { key: 'time', label: '时间与时长', width: '5.5rem' },
  { key: 'requests', label: '请求', right: true, width: '3.5rem' },
  { key: 'tokens', label: 'token', right: true, width: '4rem' },
  { key: 'cost', label: '花费', right: true, width: '4rem' },
  { key: 'workflow', label: 'workflow', width: '4.5rem' },
  { key: 'variant', label: 'variant', width: '7rem' },
  { key: 'live', label: '交互区', width: '2.75rem' },
];
// 不显示列名、只给读屏的列（勾选框一列的表头是本页的勾选框）
const hiddenLabel = new Set<ColumnKey>(['live']);

const emptyWorkflow = (s: SessionSummary) => s.purpose === null && s.workflows.length === 0;

// 所有行都为空的列：workflow 列都没有 workflow 与用途；variant 列都是本机配置（不绑定）
function emptyColumns(sessions: SessionSummary[]): Set<ColumnKey> {
  const empty = new Set<ColumnKey>();
  if (sessions.length === 0) return empty;
  if (sessions.every(emptyWorkflow)) empty.add('workflow');
  if (sessions.every((s) => s.config === 'local')) empty.add('variant');
  return empty;
}

function cells(
  session: SessionSummary,
  selected: boolean,
  disabled: boolean,
  onToggle: () => void,
): Record<ColumnKey, ReactNode> {
  const title = session.title ?? '（没有用户消息）';
  const duration = `至 ${formatDateTime(session.endedAt)} · ${formatDuration(
    durationBetween(session.startedAt, session.endedAt),
  )}`;
  const note = tableBindingNote(session);
  return {
    select: (
      <td key="select" className="py-2.5 pl-3">
        {/* 在整行链接的覆盖层之上 */}
        <input
          type="checkbox"
          className="relative z-10 size-4"
          aria-label={`选择 session ${session.id.slice(0, 8)}`}
          checked={selected}
          disabled={disabled}
          onChange={onToggle}
        />
      </td>
    ),
    title: (
      <td key="title" className="py-2.5 pr-3 pl-1">
        <Link
          to={`/sessions/${session.id}`}
          title={title}
          className="block truncate font-medium after:absolute after:inset-0 hover:underline"
        >
          {title}
        </Link>
        {session.archivedAt !== null && (
          <span
            className="mt-0.5 inline-block rounded border px-1.5 py-0.5 text-xs text-muted-foreground"
            data-testid="session-archived"
            title={`归档于 ${formatDateTime(session.archivedAt)}`}
          >
            已归档
          </span>
        )}
      </td>
    ),
    cwd: (
      <td key="cwd" className="py-2.5 pr-3 font-mono text-xs text-muted-foreground">
        <p className="truncate" title={session.cwd ?? ''} data-testid="session-cwd">
          {session.cwd ?? '—'}
        </p>
        <p className="truncate" title={session.id}>
          {session.id.slice(0, 8)}
        </p>
      </td>
    ),
    time: (
      <td key="time" className="py-2.5 pr-3 text-xs tabular-nums">
        <p className="truncate" title={formatDateTime(session.startedAt)}>
          {formatDateTime(session.startedAt)}
        </p>
        <p className="truncate text-muted-foreground" title={duration}>
          {duration}
        </p>
      </td>
    ),
    requests: (
      <td
        key="requests"
        className="truncate py-2.5 pr-3 text-right text-sm tabular-nums"
        title={formatInteger(session.requestCount)}
      >
        {formatInteger(session.requestCount)}
      </td>
    ),
    tokens: (
      <td
        key="tokens"
        className="truncate py-2.5 pr-3 text-right text-sm tabular-nums"
        title={formatCount(totalTokens(session.tokens))}
      >
        {formatCount(totalTokens(session.tokens))}
      </td>
    ),
    cost: (
      <td
        key="cost"
        className="truncate py-2.5 pr-3 text-right text-sm tabular-nums"
        data-testid="session-cost"
        title={session.priced ? formatUsd(session.costUsd) : UNPRICED}
      >
        {session.priced ? formatUsd(session.costUsd) : '—'}
      </td>
    ),
    workflow: (
      <td key="workflow" className="py-2.5 pr-3" data-testid="session-workflow">
        <span className="flex flex-wrap items-center gap-1">
          {session.purpose !== null ? (
            <PurposeBadge purpose={session.purpose} />
          ) : (
            <WorkflowBadges workflows={session.workflows} />
          )}
        </span>
      </td>
    ),
    variant: (
      <td key="variant" className="py-2.5 pr-3 text-xs" data-testid="session-variant">
        {session.config === 'local' ? (
          <span className="text-muted-foreground" title={LOCAL_NO_BINDING}>
            —
          </span>
        ) : session.variant === null ? (
          <span className="text-muted-foreground">未绑定</span>
        ) : (
          <>
            <p className="truncate font-medium" title={session.variant.name}>
              {session.variant.name}
            </p>
            {note !== null &&
              ('run' in note ? (
                <p
                  className="truncate font-mono text-muted-foreground"
                  title={`run ${note.run}`}
                  data-testid="session-run"
                >
                  {note.run}
                </p>
              ) : (
                <p className="truncate text-muted-foreground" data-testid="session-binding-kind">
                  {note.label}
                </p>
              ))}
          </>
        )}
      </td>
    ),
    live: (
      <td key="live" className="py-2 pr-3">
        <OpenInLiveButton session={session} icon className="relative z-10" />
      </td>
    ),
  };
}

// 表头的勾选框：选中或取消本页，部分选中时为半选（Contracts 25.1）
function PageCheckbox({
  state,
  disabled,
  onToggle,
}: {
  state: 'none' | 'some' | 'all';
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <input
      type="checkbox"
      className="size-4 align-middle"
      aria-label="选择本页的 session"
      data-testid="session-select-page"
      ref={(el) => {
        if (el !== null) el.indeterminate = state === 'some';
      }}
      checked={state === 'all'}
      disabled={disabled}
      onChange={onToggle}
    />
  );
}

export function SessionTable({
  sessions,
  isSelected,
  disabled,
  pageState,
  onToggle,
  onTogglePage,
}: {
  sessions: SessionSummary[];
  isSelected: (id: string) => boolean;
  // 选中全部、全部的 id 还没读到时不能改选择
  disabled: boolean;
  pageState: 'none' | 'some' | 'all';
  onToggle: (session: SessionSummary) => void;
  onTogglePage: () => void;
}) {
  const empty = emptyColumns(sessions);
  const shown = columns.filter((c) => !empty.has(c.key));
  return (
    <div className="rounded-lg border">
      <table className="w-full table-fixed text-left" data-testid="session-table">
        <colgroup>
          {shown.map((c) => (
            <col key={c.key} data-column={c.key} style={{ width: c.width }} />
          ))}
        </colgroup>
        <thead className="border-b bg-muted/40 text-xs text-muted-foreground [&_th]:truncate">
          <tr>
            {shown.map((c) => (
              <th
                key={c.key}
                className={cn(
                  'py-2 pr-3 font-medium',
                  c.key === 'select' && 'pl-3',
                  c.key === 'title' && 'pl-1',
                  c.right === true && 'text-right',
                )}
              >
                {c.key === 'select' ? (
                  <PageCheckbox state={pageState} disabled={disabled} onToggle={onTogglePage} />
                ) : hiddenLabel.has(c.key) ? (
                  <span className="sr-only">{c.label}</span>
                ) : c.key === 'variant' && sessions.some((s) => s.runId !== null) ? (
                  'variant 与 run'
                ) : (
                  c.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr]:relative">
          {sessions.map((s) => {
            const row = cells(s, isSelected(s.id), disabled, () => {
              onToggle(s);
            });
            return (
              <tr
                key={s.id}
                className="border-b align-top last:border-0 hover:bg-muted/40"
                data-testid="session-row"
                data-session={s.id}
              >
                {shown.map((c) => row[c.key])}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
