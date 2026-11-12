import { useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { SessionConversation } from '@/components/runs/conversation';
import { ImportProblemNotice } from '@/components/sessions/import-problem';
import { RequestTimeline, type TimelineFocus } from '@/components/sessions/request-timeline';
import { StageBars } from '@/components/sessions/stage-bars';
import { StageGraph } from '@/components/sessions/stage-graph';
import { StageRequests } from '@/components/sessions/stage-requests';
import { SessionSummaryPanel } from '@/components/sessions/session-summary';
import { SessionBinding } from '@/components/sessions/session-binding';
import {
  sessionQuery,
  stagesQuery,
  useSessionEvents,
  type SessionDetail,
  type StageReport,
  type WorkflowCycle,
} from '@/lib/sessions-api';
import { cycleName } from '@/lib/stage-status';

// One row per workflow (Contracts 16.6)
const workflowTitle = (workflow: string) => `/${workflow} stages`;

// stage=<workflow>:<stage> in the URL
function parseSelection(
  report: StageReport,
  value: string | null,
): { workflow: string; stage: string } | null {
  if (value === null) return null;
  const [workflow, stage] = value.split(':');
  if (workflow === undefined || stage === undefined) return null;
  if (!report.workflows.some((w) => w.workflow === workflow)) return null;
  return { workflow, stage };
}

function cycleRange(c: WorkflowCycle): string {
  return `#${String(c.startSeq)} – #${String(c.endSeq)}`;
}

// Cycle tabs of a workflow: each label is the input that opened the cycle
function CycleTabs({
  workflow,
  cycles,
  selected,
  onSelect,
}: {
  workflow: string;
  cycles: WorkflowCycle[];
  selected: number;
  onSelect: (index: number) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={`/${workflow} cycles`}
      className="flex flex-wrap gap-1"
      data-testid={`cycles-${workflow}`}
    >
      {cycles.map((c) => (
        <button
          key={c.index}
          type="button"
          role="tab"
          aria-selected={c.index === selected}
          className="flex flex-col items-start rounded-md border px-3 py-1.5 text-left aria-selected:border-foreground aria-selected:bg-foreground aria-selected:text-background"
          onClick={() => {
            onSelect(c.index);
          }}
        >
          <span className="text-sm font-medium">{cycleName(c)}</span>
          <span className="text-xs tabular-nums opacity-70">{cycleRange(c)}</span>
        </button>
      ))}
    </div>
  );
}

function StagesSection({
  session,
  report,
  focus,
  onJump,
}: {
  session: SessionDetail;
  report: StageReport;
  focus: TimelineFocus | null;
  onJump: (seq: number, toolCallId: string | null) => void;
}) {
  const [params, setParams] = useSearchParams();
  const selection = parseSelection(report, params.get('stage'));
  const detailRef = useRef<HTMLDivElement>(null);
  const update = (change: (next: URLSearchParams) => void) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        change(next);
        return next;
      },
      { replace: true },
    );
  };
  const cyclesIn = (workflow: string): WorkflowCycle[] =>
    report.workflows.find((w) => w.workflow === workflow)?.cycles ?? [];
  // Selected cycle of each workflow, cycle 1 by default
  const cycleOf = (workflow: string): WorkflowCycle | undefined => {
    const cycles = cyclesIn(workflow);
    const index = Number(params.get(workflow) ?? '1');
    return cycles.find((c) => c.index === index) ?? cycles[0];
  };
  // Clicking the selected stage again brings back all requests
  const select = (workflow: string, stage: string) => {
    const again = selection?.workflow === workflow && selection.stage === stage;
    update((next) => {
      if (again) next.delete('stage');
      else next.set('stage', `${workflow}:${stage}`);
    });
    if (again) return;
    requestAnimationFrame(() => {
      detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };
  const selectCycle = (workflow: string, index: number) => {
    update((next) => {
      next.set(workflow, String(index));
      if (parseSelection(report, next.get('stage'))?.workflow === workflow) next.delete('stage');
    });
  };
  const clear = () => {
    update((next) => {
      next.delete('stage');
    });
  };
  const graphs = report.workflows.flatMap(({ workflow: w }) => {
    const cycle = cycleOf(w);
    return cycle === undefined ? [] : [{ workflow: w, cycle }];
  });
  const selectedView =
    selection === null
      ? undefined
      : cycleOf(selection.workflow)?.stages.find((v) => v.stage === selection.stage);

  return (
    <>
      {graphs.length === 0 && (
        <p className="rounded-lg border border-dashed px-4 py-4 text-sm text-muted-foreground">
          {`This session has no cycle of ${report.workflows.map((w) => `/${w.workflow}`).join(', ')}. All requests are listed below.`}
        </p>
      )}
      {graphs.map(({ workflow, cycle }) => (
        <section
          key={workflow}
          aria-label={workflowTitle(workflow)}
          className="flex flex-col gap-4 rounded-lg border px-4 py-4"
          data-testid={`workflow-${workflow}`}
        >
          <div className="flex flex-wrap items-center gap-4">
            <h2 className="text-base font-semibold">{workflowTitle(workflow)}</h2>
            <CycleTabs
              workflow={workflow}
              cycles={cyclesIn(workflow)}
              selected={cycle.index}
              onSelect={(index) => {
                selectCycle(workflow, index);
              }}
            />
          </div>
          <StageGraph
            key={cycle.index}
            workflow={workflow}
            views={cycle.stages}
            selected={selection?.workflow === workflow ? selection.stage : null}
            onSelect={(stage) => {
              select(workflow, stage);
            }}
          />
          <StageBars views={cycle.stages} />
        </section>
      ))}
      <SessionConversation sessionId={session.id} onJump={onJump} />
      <div ref={detailRef} className="scroll-mt-4">
        {selection !== null && selectedView !== undefined ? (
          <StageRequests
            sessionId={session.id}
            workflow={selection.workflow}
            cycle={cycleOf(selection.workflow)}
            view={selectedView}
            subagents={session.subagents}
            onShowAll={clear}
          />
        ) : (
          <AllRequests session={session} hint={graphs.length > 0} focus={focus} />
        )}
      </div>
    </>
  );
}

function AllRequests({
  session,
  hint,
  focus,
}: {
  session: SessionDetail;
  hint: boolean;
  focus: TimelineFocus | null;
}) {
  return (
    <section
      aria-label="All requests"
      className="flex scroll-mt-4 flex-col gap-3"
      id="session-requests"
    >
      <h2 className="text-base font-semibold">
        All requests
        {hint && (
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            Click a stage to see only its requests
          </span>
        )}
      </h2>
      <RequestTimeline
        sessionId={session.id}
        range={{}}
        subagents={session.subagents}
        focus={focus}
      />
    </section>
  );
}

function SessionView({ session }: { session: SessionDetail }) {
  // Local config sessions show no workflow, stages or stage graph, and have no variant binding (Contracts 25.4)
  const local = session.config === 'local';
  const stages = useQuery({ ...stagesQuery(session.id), enabled: !local });
  const [params, setParams] = useSearchParams();
  // ?seq=N (evidence links in analysis reports): focus that request on open
  const linked = params.get('seq');
  const [focus, setFocus] = useState<TimelineFocus | null>(
    linked === null ? null : { seq: Number(linked), toolCallId: null, nonce: 0 },
  );
  // A conversation entry jumps to Requests: first bring back all requests, then focus the row (Requests scrolls
  // it into view)
  const jump = (seq: number, toolCallId: string | null) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('stage');
        return next;
      },
      { replace: true },
    );
    setFocus({ seq, toolCallId, nonce: Date.now() });
  };
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <SessionSummaryPanel session={session} outside={stages.data?.outside ?? null} />
      {session.importProblem !== null && <ImportProblemNotice problem={session.importProblem} />}
      {local ? (
        <>
          <SessionConversation sessionId={session.id} onJump={jump} />
          <AllRequests session={session} hint={false} focus={focus} />
        </>
      ) : (
        <>
          <SessionBinding
            sessionId={session.id}
            title={session.title}
            fromRun={session.runId !== null}
          />
          {stages.isPending ? (
            <p className="text-sm text-muted-foreground">Loading stages…</p>
          ) : stages.data === undefined ? (
            <p role="alert" className="text-sm text-destructive">
              Failed to load stages: {stages.error.message}
            </p>
          ) : (
            <>
              {stages.isError && (
                <p role="alert" className="text-sm text-destructive">
                  Failed to refresh stages: {stages.error.message}
                </p>
              )}
              <StagesSection session={session} report={stages.data} focus={focus} onJump={jump} />
            </>
          )}
        </>
      )}
    </div>
  );
}

export function SessionDetailPage() {
  useSessionEvents();
  const { id } = useParams();
  if (id === undefined) throw new Error('Route is missing the session id');
  const session = useQuery(sessionQuery(id));
  return (
    <div className="flex flex-col gap-4">
      <Link
        to="/sessions"
        className="inline-flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        All sessions
      </Link>
      {session.isPending ? (
        <p className="text-sm text-muted-foreground">Loading session…</p>
      ) : session.data === undefined ? (
        <p role="alert" className="text-sm text-destructive">
          Failed to load session: {session.error.message}
        </p>
      ) : (
        <>
          {session.isError && (
            <p role="alert" className="text-sm text-destructive">
              Failed to refresh session: {session.error.message}
            </p>
          )}
          <SessionView session={session.data} />
        </>
      )}
    </div>
  );
}
