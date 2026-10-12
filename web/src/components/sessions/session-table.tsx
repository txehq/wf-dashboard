import { Link } from 'react-router';
import { LiveBadge, WorkflowBadges } from '@/components/sessions/workflow-badges';
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

function Row({
  session,
  selected,
  onToggle,
}: {
  session: SessionSummary;
  selected: boolean;
  onToggle: () => void;
}) {
  return (
    <tr className="border-b align-top last:border-0 hover:bg-muted/40" data-testid="session-row">
      <td className="py-2.5 pl-3">
        {/* 在整行链接的覆盖层之上 */}
        <input
          type="checkbox"
          className="relative z-10 size-4"
          aria-label={`选择 session ${session.id.slice(0, 8)}`}
          checked={selected}
          onChange={onToggle}
        />
      </td>
      <td className="max-w-[28rem] py-2.5 pr-4 pl-3">
        <Link
          to={`/sessions/${session.id}`}
          className="line-clamp-2 font-medium after:absolute after:inset-0 hover:underline"
        >
          {session.title ?? '（没有用户消息）'}
        </Link>
        <p
          className="mt-0.5 truncate font-mono text-xs text-muted-foreground"
          title={session.cwd ?? ''}
        >
          {session.cwd ?? '—'} · {session.id.slice(0, 8)}
        </p>
      </td>
      <td className="py-2.5 pr-4 text-xs whitespace-nowrap tabular-nums">
        <p>{formatDateTime(session.startedAt)}</p>
        <p className="text-muted-foreground">
          至 {formatDateTime(session.endedAt)} ·{' '}
          {formatDuration(durationBetween(session.startedAt, session.endedAt))}
        </p>
      </td>
      <td className="py-2.5 pr-4 text-right text-sm tabular-nums">
        {formatInteger(session.requestCount)}
      </td>
      <td className="py-2.5 pr-4 text-right text-sm tabular-nums">
        {formatCount(totalTokens(session.tokens))}
      </td>
      <td className="py-2.5 pr-4 text-right text-sm tabular-nums">{formatUsd(session.costUsd)}</td>
      <td className="py-2.5 pr-4">
        <span className="flex flex-wrap items-center gap-1">
          <WorkflowBadges workflows={session.workflows} />
          {session.liveId !== null && <LiveBadge liveId={session.liveId} />}
        </span>
      </td>
      <td className="max-w-[12rem] py-2.5 pr-4 text-xs" data-testid="session-variant">
        {session.variant === null ? (
          <span className="text-muted-foreground">未绑定</span>
        ) : (
          <>
            <p className="truncate font-medium" title={session.variant.name}>
              {session.variant.name}
            </p>
            {session.variantBinding !== null && (
              <p className="text-muted-foreground">{bindingLabel[session.variantBinding]}</p>
            )}
          </>
        )}
      </td>
      <td className="py-2.5 pr-3 font-mono text-xs">{session.runId ?? '—'}</td>
    </tr>
  );
}

export function SessionTable({
  sessions,
  selected,
  onToggle,
}: {
  sessions: SessionSummary[];
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-left">
        <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
          <tr>
            <th className="w-8 py-2 pl-3 font-medium">
              <span className="sr-only">选择</span>
            </th>
            <th className="py-2 pr-4 pl-3 font-medium">标题与目录</th>
            <th className="py-2 pr-4 font-medium">时间与时长</th>
            <th className="py-2 pr-4 text-right font-medium">请求</th>
            <th className="py-2 pr-4 text-right font-medium">token</th>
            <th className="py-2 pr-4 text-right font-medium">花费</th>
            <th className="py-2 pr-4 font-medium">workflow</th>
            <th className="py-2 pr-4 font-medium">variant</th>
            <th className="py-2 pr-3 font-medium">run</th>
          </tr>
        </thead>
        <tbody className="[&>tr]:relative">
          {sessions.map((s) => (
            <Row
              key={s.id}
              session={s}
              selected={selected.has(s.id)}
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
