import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Ban,
  CircleSlash,
  ExternalLink,
  Hand,
  Link2,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Conversation } from '@/components/runs/conversation';
import { RunArtifacts } from '@/components/runs/run-artifacts';
import { RunGradesPanel } from '@/components/runs/run-grades';
import { RerunButton } from '@/components/runs/rerun-button';
import { StageText } from '@/components/runs/run-list';
import { RunStatusLabel } from '@/components/runs/run-status';
import { RequestTimeline, type TimelineFocus } from '@/components/sessions/request-timeline';
import { StageGraph } from '@/components/sessions/stage-graph';
import { StageRequests } from '@/components/sessions/stage-requests';
import { Button } from '@/components/ui/button';
import { formatDateTime, formatDuration, formatUsd } from '@/lib/format';
import { isNotFound } from '@/lib/http';
import {
  type CrossRunRef,
  liveStatuses,
  runAction,
  type RunDetail,
  runDuration,
  runQuery,
  setRunInvalid,
  type SourceRef,
  useRunEvents,
} from '@/lib/runs-api';
import { type StageView, sessionQuery, type WorkflowCycle } from '@/lib/sessions-api';
import { useNow } from '@/lib/use-now';
import { workflowsQuery } from '@/lib/workflows-api';

const emptyStats = {
  requests: 0,
  mainRequests: 0,
  toolCalls: {},
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  durationMs: 0,
  subagents: 0,
};

// Runs started by the dashboard have one cycle: the first cycle of the variant's workflow
const runCycle = (run: RunDetail): WorkflowCycle | undefined =>
  run.stages?.workflows.find((w) => w.workflow === run.workflowId)?.cycles[0];

// Before the session is imported or enters any stage, show the workflow's stages as not reached
function stageViews(run: RunDetail, order: string[]): StageView[] {
  const cycle = runCycle(run);
  if (cycle !== undefined) return cycle.stages;
  return order.map((stage) => ({
    stage,
    status: 'not-reached',
    startSeq: null,
    endSeq: null,
    entries: 0,
    evidence: null,
    stats: emptyStats,
  }));
}

function ExternalLinks({ links }: { links: RunDetail['links'] }) {
  const items = [
    { label: 'Linear ticket', href: links.ticket },
    { label: 'GitHub repo', href: links.repo },
    { label: 'PR', href: links.pr },
  ].filter((i): i is { label: string; href: string } => i.href !== null);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" data-testid="run-links">
      {items.map((i) => (
        <a
          key={i.label}
          href={i.href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 underline"
        >
          {i.label}
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      ))}
      {links.vault !== null && (
        <span className="inline-flex min-w-0 items-center gap-1">
          Vault folder
          <code className="truncate text-xs text-muted-foreground" title={links.vault}>
            {links.vault}
          </code>
        </span>
      )}
      {items.length === 0 && links.vault === null && (
        <span className="text-muted-foreground">
          External objects appear here once preparation creates them.
        </span>
      )}
    </div>
  );
}

const costParts = [
  { key: 'agent', label: 'agent' },
  { key: 'simulatedUser', label: 'Simulated user' },
  { key: 'grading', label: 'Grading' },
] as const;

function Costs({ costs }: { costs: RunDetail['costs'] }) {
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-1" data-testid="run-costs">
      {costParts.map((p) => (
        <div key={p.key} className="flex flex-col">
          <dt className="text-xs text-muted-foreground">{p.label}</dt>
          <dd className="tabular-nums">{formatUsd(costs[p.key])}</dd>
        </div>
      ))}
      <div className="flex flex-col">
        <dt className="text-xs text-muted-foreground">Total</dt>
        <dd className="font-semibold tabular-nums">{formatUsd(costs.total)}</dd>
      </div>
    </dl>
  );
}

function Header({ run }: { run: RunDetail }) {
  const live = liveStatuses.has(run.status);
  const now = useNow(live);
  const duration = runDuration(run, now);
  const client = useQueryClient();
  // On success, wait for the detail to refetch before re-enabling the button; does not rely on live events
  const cancel = useMutation({
    mutationFn: () => runAction(run.id, 'cancel'),
    onSuccess: () => client.invalidateQueries({ queryKey: ['runs', 'detail', run.id] }),
  });
  // Grading can also be cancelled (cancels grading and ends its child process)
  const grading = run.status === 'grading' || run.grading.status === 'running';
  const cancellable = run.status === 'queued' || run.status === 'running' || grading;
  return (
    <div className="flex flex-col gap-3 rounded-lg border px-4 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{run.taskTitle}</h1>
        <RunStatusLabel status={run.status} className="text-sm" />
        {run.status === 'running' && (
          <span className="rounded border px-1.5 py-0.5 text-xs" data-testid="run-mode">
            {run.mode === 'human' ? 'Human answering' : 'Simulated user answering'}
          </span>
        )}
        {run.humanIntervened && (
          <span
            className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs"
            data-testid="intervened"
          >
            <Hand className="size-3.5" aria-hidden />
            Human intervened
          </span>
        )}
        {cancellable && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            disabled={cancel.isPending}
            onClick={() => {
              const question = grading
                ? 'Cancel grading? Grading is recorded as failed and the run as cancelled.'
                : 'Cancel this run? It is graded on the output written so far and cannot continue.';
              if (window.confirm(question)) cancel.mutate();
            }}
          >
            <Ban />
            {cancel.isPending ? 'Cancelling…' : grading ? 'Cancel grading' : 'Cancel run'}
          </Button>
        )}
        <RerunButton run={run} className="ml-auto" />
      </div>
      <p className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
        <span className="font-mono">{run.id}</span>
        <span>
          {run.variantName} ({run.workflowId})
        </span>
        <span className="font-mono" data-testid="run-model">
          {run.model} · {run.effort}
        </span>
        <span>Repeat #{run.repeatIndex + 1}</span>
        <span>
          <StageText stage={run.currentStage} />
        </span>
        <span>Created {formatDateTime(new Date(run.createdAt).toISOString())}</span>
        {duration !== null && <span>Duration {formatDuration(duration)}</span>}
      </p>
      {cancel.isError && <p className="text-sm text-destructive">{cancel.error.message}</p>}
      <Validity run={run} />
      <ExternalLinks links={run.links} />
      <Costs costs={run.costs} />
    </div>
  );
}

// Contracts 7.12: a run broken by the evaluation environment is invalidated; all records are kept and compare always excludes it
function Validity({ run }: { run: RunDetail }) {
  const client = useQueryClient();
  const mark = useMutation({
    mutationFn: (reason: string | null) => setRunInvalid(run.id, reason),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['runs'] });
    },
  });
  if (liveStatuses.has(run.status)) return null;
  return (
    <div className="flex flex-col gap-1">
      {run.invalidReason === null ? (
        <div className="flex items-center gap-3 text-sm">
          <Button
            variant="outline"
            size="sm"
            disabled={mark.isPending}
            onClick={() => {
              const reason = window.prompt(
                'Reason for invalidating (e.g. the evaluation environment broke). The run is left out of compare; all records are kept.',
              );
              if (reason !== null && reason.trim() !== '') mark.mutate(reason.trim());
            }}
          >
            <CircleSlash />
            Invalidate
          </Button>
          <span className="text-xs text-muted-foreground">
            Invalidate a run when the evaluation environment itself broke and the run does not
            represent the variant.
          </span>
        </div>
      ) : (
        <div
          className="flex flex-wrap items-center gap-3 rounded-md border border-dashed px-3 py-2 text-sm"
          data-testid="run-invalid"
        >
          <CircleSlash className="size-4" aria-hidden />
          <span className="font-medium">Invalidated, left out of compare:</span>
          <span data-testid="run-invalid-reason">{run.invalidReason}</span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={mark.isPending}
            onClick={() => {
              mark.mutate(null);
            }}
          >
            Restore
          </Button>
        </div>
      )}
      {mark.isError && <p className="text-sm text-destructive">{mark.error.message}</p>}
    </div>
  );
}

// Contracts 7.6: grading status. A cancelled run is also graded on the output written so far
function Grading({ run }: { run: RunDetail }) {
  const { status, error } = run.grading;
  if (status === 'done') return <RunGradesPanel runId={run.id} />;
  if (status === 'running') {
    return (
      <p className="rounded-lg border px-4 py-3 text-sm" data-testid="grading-running">
        {run.status === 'cancelled'
          ? 'Grading the output written before cancellation…'
          : 'Grading…'}
      </p>
    );
  }
  if (status === 'failed') {
    return (
      <div
        role="alert"
        className="flex flex-col gap-1 rounded-lg border px-4 py-3"
        data-testid="grading-failed"
      >
        <p className="text-sm font-medium">Grading errored</p>
        <pre className="font-mono text-xs whitespace-pre-wrap">{error}</pre>
      </div>
    );
  }
  return null;
}

function Failure({ run, views }: { run: RunDetail; views: StageView[] }) {
  if (run.status !== 'failed' || run.error === null) return null;
  const at =
    views.find((v) => v.status === 'active') ??
    [...views].reverse().find((v) => v.status === 'done');
  return (
    <div
      role="alert"
      className="flex flex-col gap-1 rounded-lg border-2 border-[var(--status-critical)] px-4 py-3"
      data-testid="run-error"
    >
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <TriangleAlert className="size-4" aria-hidden />
        Run failed
        {at === undefined
          ? ' before entering any stage'
          : ` ${at.status === 'done' ? 'after' : 'at'} /${run.workflowId} · ${at.stage}`}
      </p>
      <pre className="font-mono text-xs whitespace-pre-wrap">{run.error}</pre>
    </div>
  );
}

const refKindLabel: Record<CrossRunRef['kind'], string> = {
  repo: 'Repository',
  vault: 'Vault folder',
  ticket: 'Linear ticket',
  other: 'run id',
};

// Contracts 7.11: references in this run's requests to other evaluation runs; click to locate the request in the stream
function CrossRefs({
  refs,
  onFocus,
}: {
  refs: CrossRunRef[];
  onFocus: (ref: CrossRunRef) => void;
}) {
  if (refs.length === 0) return null;
  return (
    <section
      className="flex flex-col gap-2 rounded-lg border-2 border-dashed px-4 py-3"
      aria-labelledby="cross-refs-title"
      data-testid="cross-refs"
    >
      <h2 id="cross-refs-title" className="flex items-center gap-1.5 text-sm font-medium">
        <Link2 className="size-4" aria-hidden />
        Referenced other runs
        <span className="font-normal text-muted-foreground">
          Excluded from compare by default · {refs.length} {refs.length === 1 ? 'place' : 'places'}
        </span>
      </h2>
      <ul className="flex flex-col gap-1">
        {refs.map((ref) => (
          <li
            key={`${ref.toolCallId}:${ref.runId}:${ref.kind}`}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm"
          >
            <Link to={`/runs/${ref.runId}`} className="font-mono text-xs underline">
              {ref.runId}
            </Link>
            <span className="text-xs text-muted-foreground">{refKindLabel[ref.kind]}</span>
            <button
              type="button"
              data-testid="cross-ref-jump"
              className="rounded border px-1.5 py-0.5 text-xs hover:bg-muted"
              onClick={() => {
                onFocus(ref);
              }}
            >
              Request #{ref.requestSeq}
            </button>
            <code className="min-w-0 flex-1 truncate text-xs" title={ref.excerpt}>
              {ref.excerpt}
            </code>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Contracts 13: a run of a task imported from Linear read the source ticket, repo or PR
const sourceKindLabel: Record<SourceRef['kind'], string> = {
  ticket: 'Source ticket',
  pr: 'Source PR',
  repo: 'Source repo',
};

function SourceRefs({ refs, onFocus }: { refs: SourceRef[]; onFocus: (ref: SourceRef) => void }) {
  if (refs.length === 0) return null;
  return (
    <section
      className="flex flex-col gap-2 rounded-lg border-2 border-dashed border-destructive/50 px-4 py-3"
      aria-labelledby="source-refs-title"
      data-testid="source-refs"
    >
      <h2 id="source-refs-title" className="flex items-center gap-1.5 text-sm font-medium">
        <Link2 className="size-4" aria-hidden />
        Read the source ticket / repo
        <span className="font-normal text-muted-foreground">
          Excluded from compare by default · {refs.length} {refs.length === 1 ? 'place' : 'places'}
        </span>
      </h2>
      <ul className="flex flex-col gap-1">
        {refs.map((ref) => (
          <li
            key={`${ref.toolCallId}:${ref.kind}`}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm"
          >
            <span className="text-xs text-muted-foreground">{sourceKindLabel[ref.kind]}</span>
            <button
              type="button"
              data-testid="source-ref-jump"
              className="rounded border px-1.5 py-0.5 text-xs hover:bg-muted"
              onClick={() => {
                onFocus(ref);
              }}
            >
              Request #{ref.requestSeq}
            </button>
            <code className="min-w-0 flex-1 truncate text-xs" title={ref.excerpt}>
              {ref.excerpt}
            </code>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Contracts 12: with a stage selected, show only its requests (same as Sessions detail); showing all follows the latest while running
function Requests({
  run,
  focus,
  stage,
  onShowAll,
}: {
  run: RunDetail;
  focus: TimelineFocus | null;
  stage: StageView | null;
  onShowAll: () => void;
}) {
  const session = useQuery({ ...sessionQuery(run.sessionId), retry: false });
  const live = liveStatuses.has(run.status);
  return (
    <section
      className="flex min-w-0 scroll-mt-4 flex-col gap-2"
      aria-labelledby="requests-title"
      id="run-requests"
    >
      <h2 id="requests-title" className="text-sm font-medium">
        Requests
        {stage === null && session.isSuccess && (
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            Click a stage box to see only its requests
          </span>
        )}
      </h2>
      {session.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : session.data === undefined ? (
        // Only 404 means "no session yet"; other errors (500, network) show their text
        isNotFound(session.error) ? (
          <p
            className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground"
            data-testid="requests-empty"
          >
            {live
              ? 'Claude Code has not written a session record yet. It usually appears within a few minutes of starting.'
              : 'This run has no session record.'}
          </p>
        ) : (
          <p role="alert" className="text-sm text-destructive" data-testid="requests-error">
            Could not load the session: {session.error.message}
          </p>
        )
      ) : stage !== null ? (
        <StageRequests
          sessionId={run.sessionId}
          workflow={run.workflowId}
          cycle={runCycle(run)}
          view={stage}
          subagents={session.data.subagents}
          onShowAll={onShowAll}
        />
      ) : (
        <RequestTimeline
          sessionId={run.sessionId}
          range={{}}
          subagents={session.data.subagents}
          follow={live}
          focus={focus}
        />
      )}
    </section>
  );
}

function RunView({ run }: { run: RunDetail }) {
  const workflows = useQuery(workflowsQuery);
  const order =
    workflows.data?.find((w) => w.id === run.workflowId)?.definition.stages.map((s) => s.id) ?? [];
  const views = stageViews(run, order);
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<TimelineFocus | null>(null);
  const live = liveStatuses.has(run.status);
  const selectedView = views.find((v) => v.stage === selected) ?? null;
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Header run={run} />
      <Failure run={run} views={views} />
      <CrossRefs
        refs={run.crossRunRefs}
        onFocus={(ref) => {
          setSelected(null);
          setFocus({ seq: ref.requestSeq, toolCallId: ref.toolCallId, nonce: Date.now() });
          document.getElementById('run-requests')?.scrollIntoView({ behavior: 'smooth' });
        }}
      />
      <SourceRefs
        refs={run.sourceRefs}
        onFocus={(ref) => {
          setSelected(null);
          setFocus({ seq: ref.requestSeq, toolCallId: ref.toolCallId, nonce: Date.now() });
          document.getElementById('run-requests')?.scrollIntoView({ behavior: 'smooth' });
        }}
      />
      <section
        className="flex flex-col gap-2 rounded-lg border px-4 py-3"
        aria-label="Stage progress"
        data-testid="run-stages"
      >
        <h2 className="text-sm font-medium">/{run.workflowId} stages</h2>
        <StageGraph
          workflow={run.workflowId}
          views={views}
          selected={selected}
          onSelect={(stage) => {
            const next = selected === stage ? null : stage;
            setSelected(next);
            if (next !== null) {
              requestAnimationFrame(() => {
                document
                  .getElementById('run-requests')
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              });
            }
          }}
          live={live}
        />
      </section>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
        <Conversation run={run} />
        <RunArtifacts run={run} />
      </div>
      <Grading run={run} />
      <Requests
        run={run}
        focus={focus}
        stage={selectedView}
        onShowAll={() => {
          setSelected(null);
        }}
      />
    </div>
  );
}

export function RunDetailPage() {
  useRunEvents();
  const { id } = useParams();
  if (id === undefined) throw new Error('Route is missing the run id');
  const run = useQuery(runQuery(id));
  return (
    <div className="flex flex-col gap-4">
      <Link
        to="/runs"
        className="inline-flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        All runs
      </Link>
      {run.isPending ? (
        <p className="text-sm text-muted-foreground">Loading run…</p>
      ) : run.data === undefined ? (
        <p role="alert" className="text-sm text-destructive">
          Could not load the run: {run.error.message}
        </p>
      ) : (
        <>
          {/* If a background refetch fails, keep the current content and show the error above */}
          {run.isError && (
            <p role="alert" className="text-sm text-destructive">
              Could not refresh the run: {run.error.message}
            </p>
          )}
          <RunView run={run.data} />
        </>
      )}
    </div>
  );
}
