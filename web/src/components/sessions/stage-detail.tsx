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

// Evidence: the Skill call or the slash command the user typed that entered this stage
function Evidence({ view }: { view: StageView }) {
  const e = view.evidence;
  if (e === null)
    return (
      <p className="text-sm text-muted-foreground">
        {view.status === 'skipped'
          ? 'This stage was not called in this cycle; a later stage started directly.'
          : 'This cycle did not reach this stage.'}
      </p>
    );
  return (
    <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1 text-xs" data-testid="stage-evidence">
      <Row label={evidenceKindLabel[e.kind]}>
        <span className="whitespace-pre-wrap">{e.text}</span>
      </Row>
      <Row label="In request">#{e.seq}</Row>
    </dl>
  );
}

function rangeText(view: StageView): string {
  if (view.startSeq === null || view.endSeq === null) return 'No request range';
  if (view.endSeq < view.startSeq)
    return `Empty range (the next stage starts at #${String(view.startSeq)})`;
  return `Main session requests #${String(view.startSeq)} – #${String(view.endSeq)}`;
}

export function StageDetail({
  sessionId,
  workflow,
  cycle,
  view,
  subagents,
}: {
  sessionId: string;
  // workflow id
  workflow: string;
  cycle: WorkflowCycle | undefined;
  view: StageView;
  subagents: SubagentInfo[];
}) {
  const s = view.stats;
  const hasRange = view.startSeq !== null && view.endSeq !== null && view.endSeq >= view.startSeq;
  return (
    <section
      aria-label={`${view.stage} stage detail`}
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
          <h3 className="text-sm font-medium">Call that entered this stage</h3>
          <Evidence view={view} />
        </div>
        <div className="flex flex-col gap-2 rounded-lg border px-4 py-3">
          <h3 className="text-sm font-medium">Stage stats</h3>
          <dl className="grid grid-cols-[auto_1fr_auto_1fr] gap-x-3 gap-y-1 text-xs tabular-nums">
            <dt className="text-muted-foreground">Requests</dt>
            <dd>
              {formatInteger(s.requests)} (including {s.subagents}{' '}
              {s.subagents === 1 ? 'subagent' : 'subagents'})
            </dd>
            <dt className="text-muted-foreground">Cost</dt>
            <dd>{formatUsd(s.costUsd)}</dd>
            <dt className="text-muted-foreground">input</dt>
            <dd>{formatCount(s.inputTokens)}</dd>
            <dt className="text-muted-foreground">output</dt>
            <dd>{formatCount(s.outputTokens)}</dd>
            <dt className="text-muted-foreground">cache read</dt>
            <dd>{formatCount(s.cacheReadTokens)}</dd>
            <dt className="text-muted-foreground">cache write</dt>
            <dd>{formatCount(s.cacheCreationTokens)}</dd>
            <dt className="text-muted-foreground">Duration</dt>
            <dd>{formatDuration(s.durationMs)}</dd>
          </dl>
          {Object.keys(s.toolCalls).length > 0 && (
            <ToolBars counts={s.toolCalls} label={`Calls per tool in the ${view.stage} stage`} />
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
            ? 'This stage was skipped and has no requests.'
            : view.status === 'active'
              ? 'This stage has started, but no requests have followed yet.'
              : 'This stage was not reached.'}
        </p>
      )}
    </section>
  );
}
