import { Link } from 'react-router';
import { OpenInLiveButton } from '@/components/live/open-in-live';
import { WorkflowBadges } from '@/components/sessions/workflow-badges';
import { bindingLabel } from '@/lib/analyses-api';
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

// page：Sessions 页面，行尾有"Live"按钮；pick：导入选择框，链接在新标签页打开，不可选的行标出原因
export type SessionTableMode = 'page' | 'pick';

// 表格固定宽度、各列按比例分配（Contracts 18.1）：标题与目录两列合计 35%，超出的文字截断，悬停显示全文。
// pick 模式没有 Live 一列，其余列按比例放大
const columns = [
  { key: 'select', width: 3 },
  { key: 'title', width: 20 },
  { key: 'cwd', width: 15 },
  { key: 'time', width: 11 },
  { key: 'requests', width: 5 },
  { key: 'tokens', width: 6 },
  { key: 'cost', width: 6 },
  { key: 'workflow', width: 7 },
  { key: 'variant', width: 9 },
  { key: 'run', width: 9 },
  { key: 'live', width: 9 },
] as const;

function Row({
  session,
  mode,
  selected,
  selectable,
  onToggle,
}: {
  session: SessionSummary;
  mode: SessionTableMode;
  selected: boolean;
  selectable: boolean;
  onToggle: () => void;
}) {
  const pick = mode === 'pick';
  const title = session.title ?? '（没有用户消息）';
  const duration = `至 ${formatDateTime(session.endedAt)} · ${formatDuration(
    durationBetween(session.startedAt, session.endedAt),
  )}`;
  return (
    <tr
      className="border-b align-top last:border-0 hover:bg-muted/40"
      data-testid="session-row"
      data-session={session.id}
    >
      <td className="py-2.5 pl-3">
        {/* 在整行链接的覆盖层之上 */}
        <input
          type="checkbox"
          className="relative z-10 size-4"
          aria-label={`选择 session ${session.id.slice(0, 8)}`}
          checked={selected}
          disabled={!selectable}
          onChange={onToggle}
        />
      </td>
      <td className="py-2.5 pr-3 pl-3">
        <Link
          to={`/sessions/${session.id}`}
          target={pick ? '_blank' : undefined}
          title={title}
          className="line-clamp-2 font-medium break-all after:absolute after:inset-0 hover:underline"
        >
          {title}
        </Link>
        {pick && !selectable && (
          <p className="mt-0.5 text-xs text-muted-foreground" data-testid="import-taken">
            已在交互区
          </p>
        )}
      </td>
      <td className="py-2.5 pr-3 font-mono text-xs text-muted-foreground">
        <p className="truncate" title={session.cwd ?? ''} data-testid="session-cwd">
          {session.cwd ?? '—'}
        </p>
        <p className="truncate" title={session.id}>
          {session.id.slice(0, 8)}
        </p>
      </td>
      <td className="py-2.5 pr-3 text-xs tabular-nums">
        <p className="truncate">{formatDateTime(session.startedAt)}</p>
        <p className="truncate text-muted-foreground" title={duration}>
          {duration}
        </p>
      </td>
      <td
        className="truncate py-2.5 pr-3 text-right text-sm tabular-nums"
        title={formatInteger(session.requestCount)}
      >
        {formatInteger(session.requestCount)}
      </td>
      <td
        className="truncate py-2.5 pr-3 text-right text-sm tabular-nums"
        title={formatCount(totalTokens(session.tokens))}
      >
        {formatCount(totalTokens(session.tokens))}
      </td>
      <td
        className="truncate py-2.5 pr-3 text-right text-sm tabular-nums"
        title={formatUsd(session.costUsd)}
      >
        {formatUsd(session.costUsd)}
      </td>
      <td className="py-2.5 pr-3">
        <span className="flex flex-wrap items-center gap-1">
          <WorkflowBadges workflows={session.workflows} />
        </span>
      </td>
      <td className="py-2.5 pr-3 text-xs" data-testid="session-variant">
        {session.variant === null ? (
          <span className="text-muted-foreground">未绑定</span>
        ) : (
          <>
            <p className="truncate font-medium" title={session.variant.name}>
              {session.variant.name}
            </p>
            {session.variantBinding !== null && (
              <p className="truncate text-muted-foreground">
                {bindingLabel[session.variantBinding]}
              </p>
            )}
          </>
        )}
      </td>
      <td className="truncate py-2.5 pr-3 font-mono text-xs" title={session.runId ?? ''}>
        {session.runId ?? '—'}
      </td>
      {!pick && (
        <td className="py-2 pr-3">
          <OpenInLiveButton session={session} className="relative z-10" />
        </td>
      )}
    </tr>
  );
}

export function SessionTable({
  sessions,
  mode,
  selected,
  isSelectable,
  onToggle,
}: {
  sessions: SessionSummary[];
  mode: SessionTableMode;
  selected: ReadonlySet<string>;
  isSelectable: (session: SessionSummary) => boolean;
  onToggle: (id: string) => void;
}) {
  const shown = columns.filter((c) => mode === 'page' || c.key !== 'live');
  const total = shown.reduce((sum, c) => sum + c.width, 0);
  return (
    <div className="rounded-lg border">
      <table className="w-full table-fixed text-left" data-testid="session-table">
        <colgroup>
          {shown.map((c) => (
            <col
              key={c.key}
              data-column={c.key}
              style={{ width: `${String((c.width / total) * 100)}%` }}
            />
          ))}
        </colgroup>
        <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
          <tr>
            <th className="py-2 pl-3 font-medium">
              <span className="sr-only">选择</span>
            </th>
            <th className="py-2 pr-3 pl-3 font-medium">标题</th>
            <th className="py-2 pr-3 font-medium">目录</th>
            <th className="py-2 pr-3 font-medium">时间与时长</th>
            <th className="py-2 pr-3 text-right font-medium">请求</th>
            <th className="py-2 pr-3 text-right font-medium">token</th>
            <th className="py-2 pr-3 text-right font-medium">花费</th>
            <th className="py-2 pr-3 font-medium">workflow</th>
            <th className="py-2 pr-3 font-medium">variant</th>
            <th className="py-2 pr-3 font-medium">run</th>
            {mode === 'page' && (
              <th className="py-2 pr-3 font-medium">
                <span className="sr-only">交互区</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody className="[&>tr]:relative">
          {sessions.map((s) => (
            <Row
              key={s.id}
              session={s}
              mode={mode}
              selected={selected.has(s.id)}
              selectable={isSelectable(s)}
              onToggle={() => {
                onToggle(s.id);
              }}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}
