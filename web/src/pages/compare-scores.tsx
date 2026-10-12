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
  type SelectedVariant,
  seriesColor,
} from '@/lib/compare';
import { cn } from '@/lib/utils';
import { DotStrip } from '@/pages/compare-dots';

function cellOf(result: CompareResult, variantId: string, taskId: string): CompareCell {
  const cell = result.cells.find((c) => c.variantId === variantId && c.taskId === taskId);
  if (cell === undefined) throw new Error(`对比结果中没有 ${variantId} × ${taskId}`);
  return cell;
}

// 格子的主指标：lfg 为总得分率，ic 为隐藏测试通过率，没有隐藏测试的 ic 为验收标准得分率
function mainOf(cell: CompareCell): Distribution {
  switch (cell.quality.kind) {
    case 'lfg':
      return cell.quality.total;
    case 'ic':
      return cell.quality.passRate;
    case 'ic_criteria':
      return cell.quality.criteriaRate;
  }
}

const mainLabel = { lfg: '总得分率', ic: '隐藏测试通过率', ic_criteria: '验收标准得分率' } as const;

function meanSd(d: Distribution, format: (x: number) => string): string {
  if (d.mean === null) return '—';
  return d.stdDev === null ? format(d.mean) : `${format(d.mean)} ± ${format(d.stdDev)}`;
}

// 相对基线的差值；任一边少于 2 次 run 时差值不可信，不上色
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
      {!reliable && !compact && <span>· run 少于 2 次，差值不可信</span>}
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
    return <p className="text-sm text-muted-foreground">没有已评分的 run</p>;
  }
  const label = mainLabel[cell.quality.kind];
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="text-base font-semibold tabular-nums" data-testid="cell-mean">
          {meanSd(main, (x) => percent(x))}
        </span>
        <span className="text-xs text-muted-foreground">
          {cell.quality.kind !== 'lfg' && cell.quality.reachedEnd.ratio !== null
            ? `到达终点 ${String(cell.quality.reachedEnd.values.filter((v) => v.reached).length)}/${String(main.n)} · `
            : ''}
          {main.n} 次 run
        </span>
      </div>
      <span className="sr-only">{label}</span>
      {!isBaseline && <Delta base={mainOf(base)} current={main} scale={100} unit=" 个百分点" />}
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

// 同一条目：rubric 修改过时，满分或说明不同的同名条目是不同的行
const sameItem = (a: RubricItem, b: RubricItem) =>
  a.artifact === b.artifact &&
  a.itemId === b.itemId &&
  a.criterion === b.criterion &&
  a.maxScore === b.maxScore;

function LfgDetail({ cells, variants }: { cells: CompareCell[]; variants: SelectedVariant[] }) {
  const [base] = cells;
  if (base === undefined) throw new Error('没有基线的格子');
  const items: RubricItem[] = [];
  for (const item of cells.flatMap((c) => c.rubricItems)) {
    if (!items.some((x) => sameItem(x, item))) items.push(item);
  }
  const artifacts = base.quality.kind === 'lfg' ? base.quality.artifacts : [];
  return (
    <table className="w-full text-sm" data-testid="rubric-detail">
      <thead>
        <tr className="border-b text-left text-xs text-muted-foreground">
          <th className="py-1.5 pr-3 font-medium">产物与 rubric 条目</th>
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
                {artifactLabel[artifact]} 得分率
              </th>
              {cells.map((cell, i) => {
                const rate = (c: CompareCell) => {
                  if (c.quality.kind !== 'lfg') throw new Error('lfg 行中出现 ic 格子');
                  const found = c.quality.artifacts.find((a) => a.artifact === artifact);
                  if (found === undefined) throw new Error(`格子中没有 ${artifact}`);
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
            各次 run
          </th>
          {cells.map((cell) => {
            if (cell.quality.kind === 'lfg') throw new Error('ic 行中出现 lfg 格子');
            const reached = new Map(
              cell.quality.reachedEnd.values.map((v) => [v.runId, v.reached]),
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
                      {reached.get(v.runId) === true ? '到达终点' : '未到达终点'}
                    </li>
                  ))}
                </ul>
              </td>
            );
          })}
        </tr>
        <tr>
          <th scope="row" className="py-1.5 pr-3 text-left font-medium">
            {cells[0]?.quality.kind === 'ic_criteria' ? '得分率范围' : '通过率范围'}
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
        {/* 没有隐藏测试的 ic task：每条验收标准的平均得分（满分 2） */}
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
  if (base === undefined) throw new Error('没有选中的 variant');
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
          if (variant === undefined) throw new Error('variant 与格子数量不一致');
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
            {task.task.kind === 'lfg' ? (
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
  const groups = [
    { kind: 'lfg', title: '/lfg · 总得分率', records: tasks.filter((t) => t.task.kind === 'lfg') },
    {
      kind: 'ic',
      title: '/ic · 隐藏测试通过率',
      records: tasks.filter((t) => t.task.kind === 'ic' && t.task.hiddenTests !== undefined),
    },
    {
      kind: 'ic_criteria',
      title: '/ic · 验收标准得分率（没有隐藏测试）',
      records: tasks.filter((t) => t.task.kind === 'ic' && t.task.hiddenTests === undefined),
    },
  ].filter((g) => g.records.length > 0);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">
        均值 ± 标准差。横轴 0–100%：每个点是一次 run（空心为有人工干预，菱形为参考了其他
        run，三角形为被取消的 run，点击打开详情），竖线为均值，横线为 ± 标准差。
      </p>
      <div className="overflow-x-auto rounded-lg border">
        <table className="w-full text-sm" data-testid="score-table">
          <thead>
            <tr className="border-b bg-muted/40 text-left">
              <th className="w-64 px-3 py-2 font-medium">task</th>
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
                      <span className="rounded border px-1.5 text-xs font-normal">基线</span>
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
