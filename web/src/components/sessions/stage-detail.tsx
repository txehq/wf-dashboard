import type { ReactNode } from 'react';
import { RequestTimeline } from '@/components/sessions/request-timeline';
import { ToolBars } from '@/components/sessions/session-summary';
import { StatusLabel } from '@/components/sessions/status-label';
import { formatCount, formatDuration, formatInteger, formatUsd } from '@/lib/format';
import type { StageView, SubagentInfo, WorkflowCycle } from '@/lib/sessions-api';
import { cycleName, entriesText, evidenceKindLabel } from '@/lib/stage-status';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-mono break-all">{children}</dd>
    </>
  );
}

// 证据：进入这个阶段的那次 Skill 调用或用户输入的 slash 命令
function Evidence({ view }: { view: StageView }) {
  const e = view.evidence;
  if (e === null)
    return (
      <p className="text-sm text-muted-foreground">
        {view.status === 'skipped'
          ? '这一轮中这个阶段没有被调用，直接进入了后面的阶段。'
          : '这一轮没有进入这个阶段。'}
      </p>
    );
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-xs" data-testid="stage-evidence">
      <Row label={evidenceKindLabel[e.kind]}>
        <span className="whitespace-pre-wrap">{e.text}</span>
      </Row>
      <Row label="所在请求">#{e.seq}</Row>
    </dl>
  );
}

function rangeText(view: StageView): string {
  if (view.startSeq === null || view.endSeq === null) return '没有请求区间';
  if (view.endSeq < view.startSeq) return `区间为空（下一阶段从 #${String(view.startSeq)} 开始）`;
  return `主 session 请求 #${String(view.startSeq)} – #${String(view.endSeq)}`;
}

export function StageDetail({
  sessionId,
  workflow,
  cycle,
  view,
  subagents,
}: {
  sessionId: string;
  // 大阶段 id
  workflow: string;
  cycle: WorkflowCycle | undefined;
  view: StageView;
  subagents: SubagentInfo[];
}) {
  const s = view.stats;
  const hasRange = view.startSeq !== null && view.endSeq !== null && view.endSeq >= view.startSeq;
  return (
    <section
      aria-label={`${view.stage} 阶段详情`}
      className="flex flex-col gap-4"
      data-testid="stage-detail"
    >
      <header className="flex flex-wrap items-baseline gap-3">
        <h2 className="font-mono text-lg font-semibold">
          /{workflow} · {view.stage}
        </h2>
        <StatusLabel status={view.status} />
        {cycle !== undefined && (
          <span className="rounded border px-1.5 py-0.5 text-xs" data-testid="stage-cycle">
            {cycleName(cycle)}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          {entriesText(view) !== null && (
            <>
              <span data-testid="stage-entries">{entriesText(view)}</span> ·{' '}
            </>
          )}
          {rangeText(view)}
        </span>
      </header>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-lg border px-4 py-3">
          <h3 className="text-sm font-medium">进入这个阶段的调用</h3>
          <Evidence view={view} />
        </div>
        <div className="flex flex-col gap-2 rounded-lg border px-4 py-3">
          <h3 className="text-sm font-medium">阶段统计</h3>
          <dl className="grid grid-cols-[auto_1fr_auto_1fr] gap-x-3 gap-y-1 text-xs tabular-nums">
            <dt className="text-muted-foreground">请求</dt>
            <dd>
              {formatInteger(s.requests)}（含 {s.subagents} 个子代理）
            </dd>
            <dt className="text-muted-foreground">花费</dt>
            <dd>{formatUsd(s.costUsd)}</dd>
            <dt className="text-muted-foreground">input</dt>
            <dd>{formatCount(s.inputTokens)}</dd>
            <dt className="text-muted-foreground">output</dt>
            <dd>{formatCount(s.outputTokens)}</dd>
            <dt className="text-muted-foreground">cache 读</dt>
            <dd>{formatCount(s.cacheReadTokens)}</dd>
            <dt className="text-muted-foreground">cache 写</dt>
            <dd>{formatCount(s.cacheCreationTokens)}</dd>
            <dt className="text-muted-foreground">耗时</dt>
            <dd>{formatDuration(s.durationMs)}</dd>
          </dl>
          {Object.keys(s.toolCalls).length > 0 && (
            <ToolBars counts={s.toolCalls} label={`${view.stage} 阶段各 tool 的调用次数`} />
          )}
        </div>
      </div>
      {hasRange ? (
        <RequestTimeline
          key={`${workflow}:${view.stage}`}
          sessionId={sessionId}
          range={{ fromSeq: view.startSeq ?? 0, toSeq: view.endSeq ?? 0 }}
          subagents={subagents}
        />
      ) : (
        <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
          {view.status === 'skipped'
            ? '这个阶段被跳过，没有请求。'
            : view.status === 'active'
              ? '已进入这个阶段，但之后还没有请求。'
              : '没有进入这个阶段。'}
        </p>
      )}
    </section>
  );
}
