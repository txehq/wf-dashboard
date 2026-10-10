import { Link } from 'react-router';
import { percent } from '@/lib/compare';
import { cn } from '@/lib/utils';

export interface DotValue {
  runId: string;
  value: number;
  intervened: boolean;
  crossRef: boolean;
  cancelled: boolean;
}

function marks(v: DotValue): string[] {
  return [
    v.intervened ? '有人工干预' : null,
    v.crossRef ? '参考了其他 run' : null,
    v.cancelled ? '被取消，按已写出的产物评分' : null,
  ].filter((t) => t !== null);
}

// 两个点的横向距离小于这个比例时上下错开，避免重叠
const OVERLAP = 0.03;
const ROW_PX = 14;

// 按值从小到大逐个放入第一个不会重叠的行
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

// 一个格子里各次 run 的原始值：0 到 100% 的横轴上每次 run 一个点，竖线为均值，横线为 ± 标准差。
// 点是指向 Runs 详情的链接；有人工干预的 run 画成空心，参考了其他 run 的画成菱形，被取消的画成三角形
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
      aria-label={`${label}：各次 run`}
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
          aria-label={[`run ${v.runId}：${percent(v.value, 1)}`, ...marks(v)].join('，')}
          data-testid="run-dot"
          data-cross-ref={v.crossRef}
          data-cancelled={v.cancelled}
          className="group absolute flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
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
