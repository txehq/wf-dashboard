import type { TaskRecord } from '@wf-dashboard/server/tasks/schema';
import { useState } from 'react';
import { Link } from 'react-router';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { CompareCell, CompareResult, SelectedVariant } from '@/lib/compare';
import { seriesColor } from '@/lib/compare';
import { formatUsd } from '@/lib/format';
import { cn } from '@/lib/utils';

type StageCost = NonNullable<CompareCell['cost']>['stages'][number];

// Same amount format as other pages: below 1 cent show 4 decimals, never $0.00
const usd = formatUsd;
const compact = (x: number) =>
  x >= 1_000_000
    ? `${(x / 1_000_000).toFixed(1)}M`
    : x >= 1000
      ? `${(x / 1000).toFixed(x >= 10_000 ? 0 : 1)}K`
      : x.toFixed(x >= 10 ? 0 : 1);
const minutes = (ms: number) =>
  ms >= 60_000 ? `${(ms / 60_000).toFixed(1)}m` : `${(ms / 1000).toFixed(0)}s`;

const metrics = [
  { id: 'cost', label: 'Cost', value: (s: StageCost) => s.costUsd, format: usd },
  {
    id: 'tokens',
    label: 'Tokens',
    value: (s: StageCost) =>
      s.inputTokens + s.outputTokens + s.cacheReadTokens + s.cacheCreationTokens,
    format: compact,
  },
  { id: 'duration', label: 'Duration', value: (s: StageCost) => s.durationMs, format: minutes },
  { id: 'tools', label: 'Tool calls', value: (s: StageCost) => s.toolCalls, format: compact },
] as const;
type MetricId = (typeof metrics)[number]['id'];

const breakdownParts = [
  { key: 'agent', label: 'Agent' },
  { key: 'simulatedUser', label: 'Simulated user' },
  { key: 'grading', label: 'Grading' },
] as const;

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex rounded-md border p-0.5">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          className={cn(
            'rounded px-2.5 py-1 text-sm text-muted-foreground',
            value === o.id && 'bg-secondary font-medium text-foreground',
          )}
          onClick={() => {
            onChange(o.id);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function StageChart({
  cells,
  variants,
  metric,
}: {
  cells: CompareCell[];
  variants: SelectedVariant[];
  metric: (typeof metrics)[number];
}) {
  const stages = cells.find((c) => c.cost !== null)?.cost?.stages.map((s) => s.stage) ?? [];
  const rows = stages.map((stage) => {
    const row: Record<string, string | number> = { stage };
    for (const cell of cells) {
      const s = cell.cost?.stages.find((x) => x.stage === stage);
      if (s !== undefined) {
        row[cell.variantId] = metric.value(s);
        row[`${cell.variantId}:reached`] = `${String(s.reached)}/${String(cell.runIds.length)}`;
      }
    }
    return row;
  });
  return (
    <div className="flex flex-col gap-2">
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Legend">
        {variants.map((v) => (
          <li key={v.id} className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm" style={{ background: seriesColor(v.slot) }} />
            {v.name}
          </li>
        ))}
      </ul>
      <div className="h-80" data-testid="stage-cost-chart">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={rows}
            barGap={2}
            barCategoryGap="20%"
            margin={{ top: 8, right: 8, left: 8, bottom: 0 }}
          >
            <CartesianGrid vertical={false} stroke="var(--viz-grid)" />
            <XAxis
              dataKey="stage"
              tickLine={false}
              axisLine={{ stroke: 'var(--viz-axis)' }}
              tick={{ fill: 'var(--viz-muted)', fontSize: 12 }}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              width={72}
              tick={{ fill: 'var(--viz-muted)', fontSize: 12 }}
              tickFormatter={(v: number) => metric.format(v)}
            />
            <Tooltip
              cursor={{ fill: 'var(--muted)', opacity: 0.6 }}
              content={({ active, payload, label }) => {
                if (!active || payload.length === 0) return null;
                const row = rows.find((r) => r.stage === label);
                return (
                  <div className="rounded-md border bg-background px-3 py-2 text-xs shadow-sm">
                    <p className="mb-1 font-medium">{String(label)}</p>
                    {variants.map((v) => {
                      const value = row?.[v.id];
                      if (typeof value !== 'number') return null;
                      return (
                        <p key={v.id} className="flex items-center gap-2">
                          <span
                            className="h-0.5 w-3 rounded-full"
                            style={{ background: seriesColor(v.slot) }}
                          />
                          <span className="font-semibold tabular-nums">{metric.format(value)}</span>
                          <span className="text-muted-foreground">
                            {v.name} · reached {String(row?.[`${v.id}:reached`])}
                          </span>
                        </p>
                      );
                    })}
                  </div>
                );
              }}
            />
            {variants.map((v) => (
              <Bar
                key={v.id}
                dataKey={v.id}
                name={v.name}
                fill={seriesColor(v.slot)}
                maxBarSize={24}
                radius={[4, 4, 0, 0]}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function StageTable({ cells, variants }: { cells: CompareCell[]; variants: SelectedVariant[] }) {
  const stages = cells.find((c) => c.cost !== null)?.cost?.stages.map((s) => s.stage) ?? [];
  return (
    <table className="w-full text-sm" data-testid="stage-cost-table">
      <thead>
        <tr className="border-b text-left text-xs text-muted-foreground">
          <th className="py-1.5 pr-3 font-medium">Stage</th>
          <th className="py-1.5 pr-3 font-medium">Variant</th>
          {metrics.map((m) => (
            <th key={m.id} className="px-3 py-1.5 text-right font-medium">
              {m.label}
            </th>
          ))}
          <th className="px-3 py-1.5 text-right font-medium">Reached</th>
        </tr>
      </thead>
      <tbody>
        {stages.flatMap((stage) =>
          cells.map((cell, i) => {
            const s = cell.cost?.stages.find((x) => x.stage === stage);
            const variant = variants[i];
            if (variant === undefined) throw new Error('Variant and cell counts differ');
            return (
              <tr key={`${stage}:${cell.variantId}`} className="border-b last:border-0">
                <td className="py-1 pr-3">{i === 0 ? stage : ''}</td>
                <td className="py-1 pr-3">{variant.name}</td>
                {metrics.map((m) => (
                  <td key={m.id} className="px-3 py-1 text-right tabular-nums">
                    {s === undefined ? '—' : m.format(m.value(s))}
                  </td>
                ))}
                <td className="px-3 py-1 text-right tabular-nums">
                  {s === undefined ? '—' : `${String(s.reached)}/${String(cell.runIds.length)}`}
                </td>
              </tr>
            );
          }),
        )}
      </tbody>
    </table>
  );
}

// The four parts of a run's total cost: one small chart each, bars are each variant's mean, bars of one part share an axis
function BreakdownMultiples({
  cells,
  variants,
}: {
  cells: CompareCell[];
  variants: SelectedVariant[];
}) {
  const totals = cells.map((c) => c.cost?.total ?? null);
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5" data-testid="cost-breakdown">
      {[...breakdownParts, { key: 'total', label: 'Total' } as const].map((part) => {
        const values = totals.map((t) => (t === null ? null : t[part.key]));
        const max = Math.max(...values.map((v) => v ?? 0));
        return (
          <figure key={part.key} className="flex flex-col gap-2 rounded-lg border p-3">
            <figcaption className="text-sm font-medium">{part.label}</figcaption>
            {variants.map((v, i) => {
              const value = values[i] ?? null;
              return (
                <div key={v.id} className="flex flex-col gap-0.5">
                  <span className="truncate text-xs text-muted-foreground">{v.name}</span>
                  {value === null ? (
                    <span className="text-xs text-muted-foreground">No runs</span>
                  ) : (
                    <div className="flex items-center gap-2">
                      <div
                        className="h-3 rounded-r-[4px]"
                        style={{
                          width: `${String(max === 0 ? 0 : (value / max) * 75)}%`,
                          minWidth: value > 0 ? 2 : 0,
                          background: seriesColor(v.slot),
                        }}
                      />
                      <span className="text-xs tabular-nums">{usd(value)}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </figure>
        );
      })}
    </div>
  );
}

// Contracts 7.10: friction issues filed by the agent under test, one row per variant; expand to list the issue links
function FrictionCounts({
  cells,
  variants,
}: {
  cells: CompareCell[];
  variants: SelectedVariant[];
}) {
  return (
    <ul className="flex flex-col gap-1.5" data-testid="friction-counts">
      {variants.map((v, i) => {
        const friction = cells[i]?.cost?.friction ?? null;
        return (
          <li key={v.id} className="rounded-lg border px-3 py-2 text-sm" data-variant={v.id}>
            {friction === null ? (
              <span className="flex items-center gap-2">
                <span className="size-2.5 rounded-sm" style={{ background: seriesColor(v.slot) }} />
                {v.name}
                <span className="text-xs text-muted-foreground">No runs</span>
              </span>
            ) : (
              <details>
                <summary className="flex cursor-pointer items-center gap-2">
                  <span
                    className="size-2.5 rounded-sm"
                    style={{ background: seriesColor(v.slot) }}
                  />
                  {v.name}
                  <span className="font-semibold tabular-nums" data-testid="friction-per-run">
                    {friction.perRun.toFixed(friction.perRun >= 10 ? 0 : 1)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    per run · {friction.issues.length}{' '}
                    {friction.issues.length === 1 ? 'issue' : 'issues'} in total
                  </span>
                </summary>
                {friction.issues.length === 0 ? (
                  <p className="mt-1.5 text-xs text-muted-foreground">No friction reported.</p>
                ) : (
                  <ul className="mt-1.5 flex flex-col gap-1">
                    {friction.issues.map((issue) => (
                      <li
                        key={`${issue.runId}:${issue.url}`}
                        className="flex flex-wrap items-baseline gap-x-3"
                      >
                        <a href={issue.url} target="_blank" rel="noreferrer" className="underline">
                          {issue.title === '' ? issue.url : issue.title}
                        </a>
                        {issue.url.includes('#issuecomment-') && (
                          <span className="rounded border px-1 text-xs text-muted-foreground">
                            Comment
                          </span>
                        )}
                        <Link
                          to={`/runs/${issue.runId}`}
                          className="font-mono text-xs text-muted-foreground hover:underline"
                        >
                          {issue.runId}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function CostComparison({
  result,
  tasks,
  variants,
}: {
  result: CompareResult;
  tasks: TaskRecord[];
  variants: SelectedVariant[];
}) {
  const [taskId, setTaskId] = useState<string | null>(null);
  const [metricId, setMetricId] = useState<MetricId>('cost');
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const task = tasks.find((t) => t.task.id === taskId) ?? tasks[0];
  if (task === undefined) return null;
  const cells = variants.map((v) => {
    const cell = result.cells.find((c) => c.variantId === v.id && c.taskId === task.task.id);
    if (cell === undefined) throw new Error(`Comparison result has no ${v.id} × ${task.task.id}`);
    return cell;
  });
  const metric = metrics.find((m) => m.id === metricId);
  if (metric === undefined) throw new Error(`Unknown metric ${metricId}`);
  const hasRuns = cells.some((c) => c.cost !== null);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          Task
          <select
            aria-label="Task for cost comparison"
            className="h-8 rounded-md border bg-background px-2"
            value={task.task.id}
            onChange={(event) => {
              setTaskId(event.target.value);
            }}
          >
            {tasks.map((t) => (
              <option key={t.task.id} value={t.task.id}>
                {t.task.title}
              </option>
            ))}
          </select>
        </label>
        <Segmented label="Metric" options={metrics} value={metricId} onChange={setMetricId} />
        <Segmented
          label="View"
          options={[
            { id: 'chart', label: 'Chart' },
            { id: 'table', label: 'Table' },
          ]}
          value={view}
          onChange={setView}
        />
      </div>
      {!hasRuns ? (
        <p className="text-sm text-muted-foreground">
          This task has no graded runs for the selected variants.
        </p>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <h3 className="text-sm font-medium">
              Average {metric.label.toLowerCase()} per stage (per run)
            </h3>
            <p className="text-xs text-muted-foreground">
              Runs that did not reach a stage count as 0 in that stage's average.
            </p>
            {view === 'chart' ? (
              <StageChart cells={cells} variants={variants} metric={metric} />
            ) : (
              <StageTable cells={cells} variants={variants} />
            )}
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Run cost breakdown (average per run)</h3>
            <BreakdownMultiples cells={cells} variants={variants} />
          </div>
          <div className="flex flex-col gap-2">
            <h3 className="text-sm font-medium">Friction reports (average per run)</h3>
            <FrictionCounts cells={cells} variants={variants} />
          </div>
        </>
      )}
    </div>
  );
}
