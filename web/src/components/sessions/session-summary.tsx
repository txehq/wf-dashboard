import { useState } from 'react';
import { OpenInLiveButton } from '@/components/live/open-in-live';
import { ResumeButton } from '@/components/live/resume-dialog';
import { LiveBadge, WorkflowBadges } from '@/components/sessions/workflow-badges';
import {
  durationBetween,
  formatCount,
  formatDateTime,
  formatDuration,
  formatInteger,
  formatUsd,
} from '@/lib/format';
import type { SessionDetail, StageStats } from '@/lib/sessions-api';

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border px-4 py-3">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xl font-semibold">{value}</span>
      {sub !== undefined && <span className="text-xs text-muted-foreground">{sub}</span>}
    </div>
  );
}

const TOOL_LIMIT = 10;

// 单一序列的横向条形：长度表示调用次数，数值在条形末端
export function ToolBars({ counts, label }: { counts: Record<string, number>; label: string }) {
  const [all, setAll] = useState(false);
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (entries.length === 0)
    return <p className="text-sm text-muted-foreground">没有 tool 调用。</p>;
  const shown = all ? entries : entries.slice(0, TOOL_LIMIT);
  const max = entries[0]?.[1] ?? 1;
  return (
    <figure className="flex flex-col gap-1.5" aria-label={label}>
      <ul className="flex flex-col gap-1">
        {shown.map(([name, n]) => (
          <li
            key={name}
            className="grid grid-cols-[minmax(0,14rem)_1fr] items-center gap-3 text-xs"
            title={`${name}：${formatInteger(n)} 次`}
          >
            <span className="truncate text-right font-mono text-muted-foreground">{name}</span>
            <span className="flex items-center gap-2">
              <span
                className="h-3 rounded-r-[4px] bg-[var(--viz-series-1)]"
                style={{
                  width: `${String(Math.max((n / max) * 100, 0.5))}%`,
                  maxWidth: 'calc(100% - 4rem)',
                }}
              />
              <span className="tabular-nums">{formatInteger(n)}</span>
            </span>
          </li>
        ))}
      </ul>
      {entries.length > TOOL_LIMIT && (
        <button
          type="button"
          className="self-start text-xs text-muted-foreground underline-offset-2 hover:underline"
          onClick={() => {
            setAll(!all);
          }}
        >
          {all ? '只看前 10 个' : `显示全部 ${String(entries.length)} 个 tool`}
        </button>
      )}
    </figure>
  );
}

export function SessionSummaryPanel({
  session,
  outside,
}: {
  session: SessionDetail;
  // 判定之后才有
  outside: StageStats | null;
}) {
  const t = session.tokens;
  return (
    <section
      aria-label="session 汇总"
      className="flex flex-col gap-4"
      data-testid="session-summary"
    >
      <header className="flex flex-col gap-1">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{session.title ?? '（没有用户消息）'}</h1>
          <WorkflowBadges workflows={session.workflows} />
          {session.liveId !== null && <LiveBadge liveId={session.liveId} />}
          <span className="ml-auto flex items-start gap-2">
            <OpenInLiveButton session={session} />
            <ResumeButton sessionId={session.id} />
          </span>
        </div>
        <p className="font-mono text-xs text-muted-foreground">
          {session.cwd ?? '—'} · {session.id}
          {session.runId !== null && ` · run ${session.runId}`}
        </p>
        <p className="text-xs text-muted-foreground tabular-nums">
          {formatDateTime(session.startedAt)} 至 {formatDateTime(session.endedAt)}
        </p>
      </header>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Tile label="总请求" value={formatInteger(session.requestCount)} sub="含子代理" />
        <Tile label="input token" value={formatCount(t.input)} />
        <Tile label="output token" value={formatCount(t.output)} />
        <Tile
          label="cache token"
          value={formatCount(t.cacheRead + t.cacheCreation)}
          sub={`读 ${formatCount(t.cacheRead)} · 写 ${formatCount(t.cacheCreation)}`}
        />
        <Tile label="总花费" value={formatUsd(session.costUsd)} />
        <Tile
          label="时长"
          value={formatDuration(durationBetween(session.startedAt, session.endedAt))}
          sub="首条到末条记录"
        />
        <Tile
          label="子代理"
          value={formatInteger(session.subagentCount)}
          sub={`tool 调用 ${formatInteger(session.toolCallCount)} 次`}
        />
      </div>
      {outside !== null && (
        <div
          className="flex flex-wrap items-baseline gap-x-6 gap-y-1 rounded-lg border border-dashed px-4 py-3 text-sm"
          data-testid="outside-stats"
        >
          <h2 className="font-medium">流程外</h2>
          <span className="text-xs text-muted-foreground">不属于任何一轮 /lfg 或 /ic 的请求</span>
          <span className="tabular-nums">
            {formatInteger(outside.requests)} 次请求
            <span className="text-muted-foreground">
              （占 {Math.round((outside.requests / Math.max(session.requestCount, 1)) * 100)}%）
            </span>
          </span>
          <span className="tabular-nums">{formatUsd(outside.costUsd)}</span>
          <span className="tabular-nums">{formatDuration(outside.durationMs)}</span>
        </div>
      )}
      <div className="flex flex-col gap-2 rounded-lg border px-4 py-3">
        <h2 className="text-sm font-medium">tool 使用分布</h2>
        <ToolBars counts={session.toolCounts} label="各 tool 的调用次数" />
      </div>
    </section>
  );
}
