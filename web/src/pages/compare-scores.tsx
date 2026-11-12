import type { TaskRecord } from '@wf-dashboard/server/tasks/schema';
import { ChevronDown, ChevronRight, Minus, TrendingDown, TrendingUp } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Link } from 'react-router';
import {
  artifactLabel,
  type CompareCell,
  type CompareResult,
  type Distribution,
  percent,
  qualityKind,
  type SelectedVariant,
  seriesColor,
} from '@/lib/compare';
import { cn } from '@/lib/utils';
import { DotStrip } from '@/pages/compare-dots';

function cellOf(result: CompareResult, variantId: string, taskId: string): CompareCell {
  const cell = result.cells.find((c) => c.variantId === variantId && c.taskId === taskId);
  if (cell === undefined) throw new Error(`Comparison result has no ${variantId} × ${taskId}`);
  return cell;
}

// A cell's main metric: total score rate with a rubric, pass rate with hidden tests, acceptance criteria score rate when graded by criteria
function mainOf(cell: CompareCell): Distribution {
  const q = cell.quality;
  const main = q.rubric?.total ?? q.passRate ?? q.criteriaRate;
  if (main === null)
    throw new Error(`Cell ${cell.variantId} × ${cell.taskId} has no quality metric`);
  return main;
}

const mainLabel = {
  lfg: 'Total score rate',
  ic: 'Hidden test pass rate',
  ic_criteria: 'Acceptance criteria score rate',
} as const;

function meanSd(d: Distribution, format: (x: number) => string): string {
  if (d.mean === null) return '—';
  return d.stdDev === null ? format(d.mean) : `${format(d.mean)} ± ${format(d.stdDev)}`;
}

// Difference from the baseline; with fewer than 2 runs on either side it is unreliable and not colored
function Delta({
  base,
  current,
  scale,
  unit,
  compact = false,
}: {
  base: Distribution;
  current: Distribution;
  scale: number;
  unit: string;
  compact?: boolean;
}) {
  if (base.mean === null || current.mean === null) return null;
  const d = (current.mean - base.mean) * scale;
  const reliable = base.n >= 2 && current.n >= 2;
  const rounded = Math.round(d * 10) / 10;
  const direction = rounded > 0 ? 'up' : rounded < 0 ? 'down' : 'flat';
  const Icon = direction === 'up' ? TrendingUp : direction === 'down' ? TrendingDown : Minus;
  const text = `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}${unit}`;
  return (
    <span
      data-testid="delta"
      data-direction={direction}
      data-reliable={reliable}
      className={cn(
        'inline-flex items-center gap-1 text-xs tabular-nums',
        !reliable && 'text-muted-foreground',
        reliable && direction === 'up' && 'text-[var(--status-good)]',
        reliable && direction === 'down' && 'text-[var(--status-critical)]',
        reliable && direction === 'flat' && 'text-muted-foreground',
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {text}
      {!reliable && !compact && <span>· fewer than 2 runs, difference unreliable</span>}
    </span>
  );
}

function ScoreCell({
  cell,
  base,
  variant,
  intervened,
  crossRef,
  sourceRef,
  cancelled,
  isBaseline,
}: {
  cell: CompareCell;
  base: CompareCell;
  variant: SelectedVariant;
  intervened: Set<string>;
  crossRef: Set<string>;
  sourceRef: Set<string>;
  cancelled: Set<string>;
  isBaseline: boolean;
}) {
  const main = mainOf(cell);
  if (main.n === 0) {
    return <p className="text-sm text-muted-foreground">No graded runs</p>;
  }
  const label = mainLabel[qualityKind(cell.quality)];
  const reachedEnd = cell.quality.rubric === null ? cell.quality.reachedEnd : null;
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-base font-semibold tabular-nums" data-testid="cell-mean">
          {meanSd(main, (x) => percent(x))}
        </span>
        <span className="text-xs text-muted-foreground">
          {reachedEnd !== null && reachedEnd.ratio !== null
            ? `Endpoint reached ${String(reachedEnd.values.filter((v) => v.reached).length)}/${String(main.n)} · `
            : ''}
          {main.n} {main.n === 1 ? 'run' : 'runs'}
        </span>
      </div>
      <span className="sr-only">{label}</span>
      {!isBaseline && <Delta base={mainOf(base)} current={main} scale={100} unit=" pp" />}
      <DotStrip
        values={main.values.map((v) => ({
          ...v,
          intervened: intervened.has(v.runId),
          crossRef: crossRef.has(v.runId),
          sourceRef: sourceRef.has(v.runId),
          cancelled: cancelled.has(v.runId),
        }))}
        mean={main.mean}
        stdDev={main.stdDev}
        color={seriesColor(variant.slot)}
        label={`${variant.name} ${label}`}
      />
    </div>
  );
}

type RubricItem = CompareCell['rubricItems'][number];

// Same item: after a rubric edit, same-named items with a different max score or description are different rows
const sameItem = (a: RubricItem, b: RubricItem) =>
  a.artifact === b.artifact &&
  a.itemId === b.itemId &&
  a.criterion === b.criterion &&
  a.maxScore === b.maxScore;

function LfgDetail({ cells, variants }: { cells: CompareCell[]; variants: SelectedVariant[] }) {
  const [base] = cells;
  if (base === undefined) throw new Error('No baseline cell');
  const items: RubricItem[] = [];
  for (const item of cells.flatMap((c) => c.rubricItems)) {
    if (!items.some((x) => sameItem(x, item))) items.push(item);
  }
  const artifacts = base.quality.rubric?.artifacts ?? [];
  return (
    <table className="w-full text-sm" data-testid="rubric-detail">
      <thead>
        <tr className="border-b text-left text-xs text-muted-foreground">
          <th className="py-1.5 pr-3 font-medium">Output and rubric item</th>
          {variants.map((v) => (
            <th key={v.id} className="w-56 px-3 py-1.5 font-medium">
              {v.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {artifacts.map(({ artifact }) => (
          <Fragment key={artifact}>
            <tr className="border-b bg-muted/40">
              <th scope="row" className="py-1.5 pr-3 text-left font-medium">
                {artifactLabel(artifact)} score rate
              </th>
              {cells.map((cell, i) => {
                const rate = (c: CompareCell) => {
                  if (c.quality.rubric === null)
                    throw new Error('A cell without a rubric in a rubric row');
                  const found = c.quality.rubric.artifacts.find((a) => a.artifact === artifact);
                  if (found === undefined) throw new Error(`Cell has no ${artifact}`);
                  return found.rate;
                };
                return (
                  <td key={cell.variantId} className="px-3 py-1.5">
                    <span className="font-medium tabular-nums">
                      {meanSd(rate(cell), (x) => percent(x))}
                    </span>{' '}
                    {i > 0 && (
                      <Delta base={rate(base)} current={rate(cell)} scale={100} unit="" compact />
                    )}
                  </td>
                );
              })}
            </tr>
            {items
              .filter((item) => item.artifact === artifact)
              .map((item) => (
                <tr
                  key={`${item.itemId}\0${item.criterion}\0${String(item.maxScore)}`}
                  className="border-b last:border-0"
                >
                  <td className="py-1.5 pr-3">
                    <span className="mr-2 font-mono text-xs text-muted-foreground">
                      {item.itemId}
                    </span>
                    {item.criterion}
                  </td>
                  {cells.map((cell, i) => {
                    const own = cell.rubricItems.find((x) => sameItem(x, item));
                    const baseItem = base.rubricItems.find((x) => sameItem(x, item));
                    if (own?.score.mean == null) {
                      return (
                        <td key={cell.variantId} className="px-3 py-1.5 text-muted-foreground">
                          —
                        </td>
                      );
                    }
                    return (
                      <td key={cell.variantId} className="px-3 py-1.5 tabular-nums">
                        {own.score.mean.toFixed(1)} / {own.maxScore}{' '}
                        {i > 0 && baseItem !== undefined && (
                          <Delta
                            base={baseItem.score}
                            current={own.score}
                            scale={1}
                            unit=""
                            compact
                          />
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
          </Fragment>
        ))}
      </tbody>
    </table>
  );
}

function IcDetail({ cells, variants }: { cells: CompareCell[]; variants: SelectedVariant[] }) {
  return (
    <table className="w-full text-sm" data-testid="ic-detail">
      <thead>
        <tr className="border-b text-left text-xs text-muted-foreground">
          <th className="py-1.5 pr-3 font-medium" />
          {variants.map((v) => (
            <th key={v.id} className="w-56 px-3 py-1.5 font-medium">
              {v.name}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        <tr className="border-b">
          <th scope="row" className="py-1.5 pr-3 text-left font-medium">
            Runs
          </th>
          {cells.map((cell) => {
            const reached = new Map(
              (cell.quality.reachedEnd?.values ?? []).map((v) => [v.runId, v.reached]),
            );
            return (
              <td key={cell.variantId} className="px-3 py-1.5 align-top">
                <ul className="flex flex-col gap-0.5">
                  {mainOf(cell).values.map((v) => (
                    <li key={v.runId} className="tabular-nums">
                      <Link to={`/runs/${v.runId}`} className="font-mono text-xs underline">
                        {v.runId}
                      </Link>{' '}
                      {percent(v.value)} ·{' '}
                      {reached.get(v.runId) === true ? 'Endpoint reached' : 'Endpoint not reached'}
                    </li>
                  ))}
                </ul>
              </td>
            );
          })}
        </tr>
        <tr>
          <th scope="row" className="py-1.5 pr-3 text-left font-medium">
            {cells[0] !== undefined && qualityKind(cells[0].quality) === 'ic_criteria'
              ? 'Score rate range'
              : 'Pass rate range'}
          </th>
          {cells.map((cell) => {
            const d = mainOf(cell);
            return (
              <td key={cell.variantId} className="px-3 py-1.5 tabular-nums">
                {d.min === null || d.max === null ? '—' : `${percent(d.min)} – ${percent(d.max)}`}
              </td>
            );
          })}
        </tr>
        {/* ic tasks without hidden tests: average score of each acceptance criterion (max 2) */}
        {(cells[0]?.criteriaItems ?? []).map((item) => (
          <tr
            key={`${item.itemId}\0${item.criterion}`}
            className="border-t"
            data-testid="criterion-row"
          >
            <th scope="row" className="py-1.5 pr-3 text-left font-normal">
              <span className="mr-1 font-mono text-xs text-muted-foreground">{item.itemId}</span>
              <span className="line-clamp-2">{item.criterion}</span>
            </th>
            {cells.map((cell) => {
              const own = cell.criteriaItems.find(
                (c) => c.itemId === item.itemId && c.criterion === item.criterion,
              );
              return (
                <td key={cell.variantId} className="px-3 py-1.5 tabular-nums">
                  {own?.score.mean == null
                    ? '—'
                    : `${own.score.mean.toFixed(1)} / ${String(own.maxScore)}`}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function TaskRow({
  task,
  result,
  variants,
  intervened,
  crossRef,
  sourceRef,
  cancelled,
}: {
  task: TaskRecord;
  result: CompareResult;
  variants: SelectedVariant[];
  intervened: Set<string>;
  crossRef: Set<string>;
  sourceRef: Set<string>;
  cancelled: Set<string>;
}) {
  const [open, setOpen] = useState(false);
  const cells = variants.map((v) => cellOf(result, v.id, task.task.id));
  const [base] = cells;
  if (base === undefined) throw new Error('No variant selected');
  const Icon = open ? ChevronDown : ChevronRight;
  return (
    <>
      <tr className="border-b align-top" data-testid={`score-row-${task.task.id}`}>
        <th scope="row" className="py-3 pr-3 text-left font-normal">
          <button
            type="button"
            aria-expanded={open}
            className="flex items-start gap-1 text-left hover:underline"
            onClick={() => {
              setOpen(!open);
            }}
          >
            <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <span>
              <span className="font-medium">{task.task.title}</span>
              <span className="block font-mono text-xs text-muted-foreground">{task.task.id}</span>
            </span>
          </button>
        </th>
        {cells.map((cell, i) => {
          const variant = variants[i];
          if (variant === undefined) throw new Error('Variant and cell counts differ');
          return (
            <td key={cell.variantId} className="px-3 py-3" data-testid="score-cell">
              <ScoreCell
                cell={cell}
                base={base}
                variant={variant}
                intervened={intervened}
                crossRef={crossRef}
                sourceRef={sourceRef}
                cancelled={cancelled}
                isBaseline={i === 0}
              />
            </td>
          );
        })}
      </tr>
      {open && (
        <tr className="border-b bg-muted/20">
          <td colSpan={variants.length + 1} className="px-3 py-3">
            {task.task.rubric !== undefined ? (
              <LfgDetail cells={cells} variants={variants} />
            ) : (
              <IcDetail cells={cells} variants={variants} />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

export function ScoreTable({
  result,
  variants,
  tasks,
  intervened,
  crossRef,
  sourceRef,
  cancelled,
}: {
  result: CompareResult;
  variants: SelectedVariant[];
  tasks: TaskRecord[];
  intervened: Set<string>;
  crossRef: Set<string>;
  sourceRef: Set<string>;
  cancelled: Set<string>;
}) {
  // The selected tasks belong to one workflow's eval types (Contracts 16.5); grouped by the grading block's main metric
  const stage = `/${result.workflowId}`;
  const groups = [
    {
      kind: 'lfg',
      title: `${stage} · Total score rate`,
      records: tasks.filter((t) => t.task.rubric !== undefined),
    },
    {
      kind: 'ic',
      title: `${stage} · Hidden test pass rate`,
      records: tasks.filter((t) => t.task.rubric === undefined && t.task.hiddenTests !== undefined),
    },
    {
      kind: 'ic_criteria',
      title: `${stage} · Acceptance criteria score rate (no hidden tests)`,
      records: tasks.filter((t) => t.task.rubric === undefined && t.task.hiddenTests === undefined),
    },
  ].filter((g) => g.records.length > 0);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        Mean ± standard deviation. Axis 0–100%: each dot is a run (hollow: human intervened,
        diamond: referenced other runs, triangle: cancelled; click to open it), the vertical line is
        the mean, the horizontal line is ± standard deviation.
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm" data-testid="score-table">
          <thead>
            <tr className="border-b bg-muted/40 text-left">
              <th className="w-64 px-3 py-2 font-medium">Task</th>
              {variants.map((v, i) => (
                <th key={v.id} className="min-w-56 px-3 py-2 font-medium">
                  <span className="flex items-center gap-2">
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ background: seriesColor(v.slot) }}
                      aria-hidden
                    />
                    {v.name}
                    {i === 0 && (
                      <span className="rounded border px-1.5 text-xs font-normal">Baseline</span>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {groups.map((group) => (
              <Fragment key={group.kind}>
                <tr className="border-b">
                  <th
                    colSpan={variants.length + 1}
                    className="px-3 pt-3 pb-1 text-left text-xs font-medium text-muted-foreground"
                  >
                    {group.title}
                  </th>
                </tr>
                {group.records.map((task) => (
                  <TaskRow
                    key={task.task.id}
                    task={task}
                    result={result}
                    variants={variants}
                    intervened={intervened}
                    crossRef={crossRef}
                    sourceRef={sourceRef}
                    cancelled={cancelled}
                  />
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
