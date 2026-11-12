import { useQuery } from '@tanstack/react-query';
import { CircleSlash, Hand, Link2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { RerunButton } from '@/components/runs/rerun-button';
import { RunStatusLabel } from '@/components/runs/run-status';
import { formatDateTime, formatDuration, formatUsd } from '@/lib/format';
import { statusMeta } from '@/lib/stage-status';
import {
  batchesQuery,
  liveStatuses,
  runDuration,
  type RunFilter,
  type RunStatus,
  type RunSummary,
  runStatuses,
  runsQuery,
  statusLabel,
} from '@/lib/runs-api';
import { tasksQuery } from '@/lib/tasks';
import { useNow } from '@/lib/use-now';
import { cn } from '@/lib/utils';
import { variantsQuery } from '@/pages/variants-api';

export function StageText({ stage }: { stage: RunSummary['currentStage'] }) {
  if (stage === null) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="font-mono text-xs">
      /{stage.workflow} · {stage.stage}
      {stage.status === 'active' ? '' : ` (${statusMeta[stage.status].label})`}
    </span>
  );
}

function FilterSelect<T extends string>({
  label,
  value,
  options,
  error = null,
  onChange,
}: {
  label: string;
  value: T | null;
  options: { value: T; label: string }[];
  // When options fail to load, show the error text; do not treat it as no options
  error?: Error | null;
  onChange: (value: T | null) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      {label}
      <select
        aria-label={label}
        className="h-8 rounded-md border bg-background px-2"
        value={value ?? ''}
        onChange={(event) => {
          onChange(event.target.value === '' ? null : (event.target.value as T));
        }}
      >
        <option value="">All</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error !== null && (
        <span role="alert" className="text-xs text-destructive">
          Could not load options: {error.message}
        </span>
      )}
    </label>
  );
}

function RunRow({ run, now }: { run: RunSummary; now: number }) {
  const duration = runDuration(run, now);
  return (
    <tr
      className={cn(
        'border-b last:border-0 hover:bg-muted/40',
        // Invalidated run: the whole row is struck through; the reason is in the last column and the tooltip
        run.invalidReason !== null && 'text-muted-foreground line-through',
      )}
      data-testid="run-row"
      data-run={run.id}
      data-invalid={run.invalidReason !== null}
      title={run.invalidReason === null ? undefined : `Invalidated: ${run.invalidReason}`}
    >
      <td className="py-2 pr-3">
        <Link to={`/runs/${run.id}`} className="font-medium hover:underline">
          {run.taskTitle}
        </Link>
        <span className="block font-mono text-xs text-muted-foreground">{run.id}</span>
      </td>
      <td className="px-3 py-2">
        {run.variantName} ({run.workflowId})
        <span className="block font-mono text-xs text-muted-foreground">
          {run.model} · {run.effort}
        </span>
      </td>
      <td className="px-3 py-2 tabular-nums">#{run.repeatIndex + 1}</td>
      <td className="px-3 py-2">
        <RunStatusLabel status={run.status} />
      </td>
      <td className="px-3 py-2">
        <StageText stage={run.currentStage} />
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{formatUsd(run.costUsd)}</td>
      <td className="px-3 py-2 text-right tabular-nums">
        {duration === null ? '—' : formatDuration(duration)}
      </td>
      <td className="py-2 pl-3">
        <span className="flex flex-col gap-0.5">
          {run.invalidReason !== null && (
            <span
              className="inline-flex items-center gap-1 text-xs no-underline"
              data-testid="invalid"
            >
              <CircleSlash className="size-3.5" aria-hidden />
              Invalidated
            </span>
          )}
          {run.humanIntervened && (
            <span className="inline-flex items-center gap-1 text-xs" data-testid="intervened">
              <Hand className="size-3.5" aria-hidden />
              Human intervened
            </span>
          )}
          {run.crossRunRefs.length > 0 && (
            <span
              className="inline-flex items-center gap-1 text-xs"
              data-testid="cross-ref"
              title={[...new Set(run.crossRunRefs.map((r) => r.runId))].join(', ')}
            >
              <Link2 className="size-3.5" aria-hidden />
              Referenced other runs
            </span>
          )}
          {run.sourceRefs.length > 0 && (
            <span
              className="inline-flex items-center gap-1 text-xs"
              data-testid="source-ref"
              title={`${String(run.sourceRefs.length)} ${run.sourceRefs.length === 1 ? 'place' : 'places'}`}
            >
              <Link2 className="size-3.5" aria-hidden />
              Read the source
            </span>
          )}
          <RerunButton run={run} className="no-underline" />
        </span>
      </td>
    </tr>
  );
}

export function RunList() {
  const [filter, setFilter] = useState<RunFilter>({ status: null, task: null, variant: null });
  const runs = useQuery(runsQuery(filter));
  const batches = useQuery(batchesQuery);
  const tasks = useQuery(tasksQuery);
  const variants = useQuery(variantsQuery);
  const now = useNow((runs.data ?? []).some((r) => liveStatuses.has(r.status)));

  const groups: { batchId: string; runs: RunSummary[] }[] = [];
  for (const run of runs.data ?? []) {
    const group = groups.find((g) => g.batchId === run.batchId);
    if (group === undefined) groups.push({ batchId: run.batchId, runs: [run] });
    else group.runs.push(run);
  }
  for (const g of groups) {
    g.runs.sort((a, b) => a.createdAt - b.createdAt || a.repeatIndex - b.repeatIndex);
  }
  const filtered = filter.status !== null || filter.task !== null || filter.variant !== null;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="run-list-title">
      <h2 id="run-list-title" className="text-lg font-semibold">
        Runs
      </h2>
      <div className="flex flex-wrap items-center gap-4">
        <FilterSelect<RunStatus>
          label="Status"
          value={filter.status}
          options={runStatuses.map((s) => ({ value: s, label: statusLabel[s] }))}
          onChange={(status) => {
            setFilter({ ...filter, status });
          }}
        />
        <FilterSelect
          label="Task"
          value={filter.task}
          options={(tasks.data ?? []).map((t) => ({ value: t.task.id, label: t.task.title }))}
          error={tasks.error}
          onChange={(task) => {
            setFilter({ ...filter, task });
          }}
        />
        <FilterSelect
          label="Variant"
          value={filter.variant}
          options={(variants.data ?? []).map((v) => ({ value: v.id, label: v.name }))}
          error={variants.error}
          onChange={(variant) => {
            setFilter({ ...filter, variant });
          }}
        />
      </div>
      {runs.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {runs.isError && <p className="text-sm text-destructive">{runs.error.message}</p>}
      {runs.data?.length === 0 && (
        <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
          {filtered
            ? 'No runs match these filters.'
            : 'No runs yet. Pick variants and tasks above to start an evaluation.'}
        </p>
      )}
      {groups.map((group) => {
        const batch = batches.data?.find((b) => b.id === group.batchId);
        return (
          <div
            key={group.batchId}
            className="rounded-lg border"
            data-testid="batch-group"
            data-batch={group.batchId}
          >
            <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b bg-muted/40 px-3 py-2 text-sm">
              <span className="font-mono font-medium">{group.batchId}</span>
              {batch !== undefined && (
                <>
                  <span className="text-xs text-muted-foreground">
                    {formatDateTime(new Date(batch.createdAt).toISOString())} · {batch.runs}{' '}
                    {batch.runs === 1 ? 'run' : 'runs'} · {batch.repeats}{' '}
                    {batch.repeats === 1 ? 'repeat' : 'repeats'} each
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {Object.entries(batch.statusCounts)
                      .map(([s, n]) => `${statusLabel[s as RunStatus]} ${String(n)}`)
                      .join(' · ')}
                  </span>
                  <span className="ml-auto text-xs tabular-nums">
                    Total {formatUsd(batch.costUsd)}
                  </span>
                </>
              )}
              <Link
                to={`/analyses/new?batch=${group.batchId}`}
                className={`text-xs underline ${batch === undefined ? 'ml-auto' : ''}`}
                data-testid="analyze-batch"
              >
                Analyze these sessions
              </Link>
            </div>
            <table className="w-full table-fixed text-sm">
              <colgroup>
                <col />
                <col className="w-[18%]" />
                <col className="w-20" />
                <col className="w-24" />
                <col className="w-[16%]" />
                <col className="w-24" />
                <col className="w-32" />
                <col className="w-32" />
              </colgroup>
              <thead>
                <tr className="border-b text-left text-xs text-muted-foreground">
                  <th className="py-1.5 pr-3 pl-3 font-medium">Task</th>
                  <th className="px-3 py-1.5 font-medium">Variant</th>
                  <th className="px-3 py-1.5 font-medium">Repeat</th>
                  <th className="px-3 py-1.5 font-medium">Status</th>
                  <th className="px-3 py-1.5 font-medium">Current stage</th>
                  <th className="px-3 py-1.5 text-right font-medium">Cost</th>
                  <th className="px-3 py-1.5 text-right font-medium">Duration</th>
                  <th className="py-1.5 pl-3 font-medium" />
                </tr>
              </thead>
              <tbody className="[&_td:first-child]:pl-3">
                {group.runs.map((run) => (
                  <RunRow key={run.id} run={run} now={now} />
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </section>
  );
}
