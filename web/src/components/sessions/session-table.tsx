import { Check, Minus } from 'lucide-react';
import { Link } from 'react-router';
import { WorkflowBadges } from '@/components/sessions/workflow-badges';
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

function Row({ session }: { session: SessionSummary }) {
  return (
    <tr className="border-b align-top last:border-0 hover:bg-muted/40" data-testid="session-row">
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
        <WorkflowBadges workflows={session.workflows} />
      </td>
      <td className="py-2.5 pr-4 text-sm">
        {session.analyzed ? (
          <span className="inline-flex items-center gap-1">
            <Check className="size-3.5" aria-hidden />
            已分析
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Minus className="size-3.5" aria-hidden />
            未分析
          </span>
        )}
      </td>
      <td className="py-2.5 pr-3 font-mono text-xs">{session.runId ?? '—'}</td>
    </tr>
  );
}

export function SessionTable({ sessions }: { sessions: SessionSummary[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-left">
        <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
          <tr>
            <th className="py-2 pr-4 pl-3 font-medium">标题与目录</th>
            <th className="py-2 pr-4 font-medium">时间与时长</th>
            <th className="py-2 pr-4 text-right font-medium">请求</th>
            <th className="py-2 pr-4 text-right font-medium">token</th>
            <th className="py-2 pr-4 text-right font-medium">花费</th>
            <th className="py-2 pr-4 font-medium">workflow</th>
            <th className="py-2 pr-4 font-medium">阶段</th>
            <th className="py-2 pr-3 font-medium">run</th>
          </tr>
        </thead>
        <tbody className="[&>tr]:relative">
          {sessions.map((s) => (
            <Row key={s.id} session={s} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
