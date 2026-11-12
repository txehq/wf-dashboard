import { Link } from 'react-router';
import { percent } from '@/lib/compare';
import { cn } from '@/lib/utils';

export interface DotValue {
  runId: string;
  value: number;
  intervened: boolean;
  crossRef: boolean;
  sourceRef: boolean;
  cancelled: boolean;
}

function marks(v: DotValue): string[] {
  return [
    v.intervened ? 'human intervened' : null,
    v.crossRef ? 'referenced other runs' : null,
    v.sourceRef ? 'read the source ticket or repo' : null,
    v.cancelled ? 'cancelled, graded on the output written so far' : null,
  ].filter((t) => t !== null);
}

// When two dots are closer than this fraction horizontally, offset them vertically to avoid overlap
const OVERLAP = 0.03;
const ROW_PX = 14;

// Place each value, smallest first, in the first row where it does not overlap
function stack(values: DotValue[]): { dot: DotValue; row: number }[] {
  const lastInRow: number[] = [];
  return [...values]
    .sort((a, b) => a.value - b.value)
    .map((dot) => {
      let row = lastInRow.findIndex((x) => dot.value - x >= OVERLAP);
      if (row === -1) row = lastInRow.length;
      lastInRow[row] = dot.value;
      return { dot, row };
    });
}

// Raw values of each run in a cell: one dot per run on a 0 to 100% axis, a vertical line for the mean, a horizontal line for ± standard deviation.
// Dots link to the run detail; human-intervened runs are hollow, runs that referenced other runs are diamonds, cancelled runs are triangles
export function DotStrip({
  values,
  mean,
  stdDev,
  color,
  label,
}: {
  values: DotValue[];
  mean: number | null;
  stdDev: number | null;
  color: string;
  label: string;
}) {
  const x = (v: number) => `${String(Math.min(Math.max(v, 0), 1) * 100)}%`;
  const placed = stack(values);
  const rows = Math.max(1, ...placed.map((p) => p.row + 1));
  return (
    <div
      className="relative mx-3"
      style={{ height: 24 + (rows - 1) * ROW_PX }}
      role="group"
      aria-label={`${label}: runs`}
    >
      <div className="pointer-events-none absolute inset-x-0 top-3 h-px bg-[var(--viz-grid)]" />
      {mean !== null && stdDev !== null && (
        <div
          className="pointer-events-none absolute top-3 h-0.5 -translate-y-1/2 rounded-full bg-[var(--viz-axis)]"
          style={{ left: x(mean - stdDev), right: `calc(100% - ${x(mean + stdDev)})` }}
        />
      )}
      {mean !== null && (
        <div
          className="pointer-events-none absolute top-3 h-3 w-0.5 -translate-x-1/2 -translate-y-1/2 bg-foreground"
          style={{ left: x(mean) }}
        />
      )}
      {placed.map(({ dot: v, row }) => (
        <Link
          key={v.runId}
          to={`/runs/${v.runId}`}
          title={[`${v.runId} · ${percent(v.value, 1)}`, ...marks(v)].join(' · ')}
          aria-label={[`run ${v.runId}: ${percent(v.value, 1)}`, ...marks(v)].join(', ')}
          data-testid="run-dot"
          data-cross-ref={v.crossRef}
          data-source-ref={v.sourceRef}
          data-cancelled={v.cancelled}
          className={cn(
            'group absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring',
            // Read the source: a red ring around the dot
            v.sourceRef && 'border border-destructive',
          )}
          style={{ left: x(v.value), top: 12 + row * ROW_PX }}
        >
          {v.cancelled ? (
            <svg
              viewBox="0 0 12 12"
              className="size-3 transition-transform group-hover:scale-150 group-focus-visible:scale-150"
              aria-hidden
            >
              <polygon
                points="6,1 11,11 1,11"
                fill={v.intervened ? 'var(--viz-surface)' : color}
                stroke={color}
                strokeWidth={v.intervened ? 2 : 0}
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <span
              className={cn(
                'ring-2 ring-[var(--viz-surface)] transition-transform group-hover:scale-150 group-focus-visible:scale-150',
                v.crossRef ? 'size-2 rotate-45' : 'size-2.5 rounded-full',
              )}
              style={
                v.intervened
                  ? { background: 'var(--viz-surface)', boxShadow: `inset 0 0 0 2px ${color}` }
                  : { background: color }
              }
            />
          )}
        </Link>
      ))}
    </div>
  );
}
