import { useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';
import { formatDuration, formatUsd } from '@/lib/format';
import type { StageView } from '@/lib/sessions-api';
import { statusMeta } from '@/lib/stage-status';

interface Datum {
  stage: string;
  value: number;
  status: StageView['status'];
}

interface Measure {
  title: string;
  value: (v: StageView) => number;
  format: (n: number) => string;
}

const measures: Measure[] = [
  { title: '各阶段花费', value: (v) => v.stats.costUsd, format: formatUsd },
  { title: '各阶段耗时', value: (v) => v.stats.durationMs, format: formatDuration },
];

// 跳过与未到达的阶段没有数值：轴标签写明状态，避免读成 0
function hasValue(d: Datum): boolean {
  return d.status !== 'skipped' && d.status !== 'not-reached';
}

function valueLabel(d: Datum, format: (n: number) => string) {
  return hasValue(d) ? format(d.value) : statusMeta[d.status].label;
}

function ChartTooltip({
  active,
  payload,
  format,
}: TooltipContentProps & { format: (n: number) => string }) {
  const d = payload[0]?.payload as Datum | undefined;
  if (!active || d === undefined) return null;
  return (
    <div className="rounded-md border bg-popover px-3 py-2 text-xs shadow-sm">
      <p className="text-sm font-semibold">{valueLabel(d, format)}</p>
      <p className="font-mono text-muted-foreground">{d.stage}</p>
    </div>
  );
}

const ROW_HEIGHT = 30;

function MeasureChart({ views, measure }: { views: StageView[]; measure: Measure }) {
  const data: Datum[] = views.map((v) => ({
    stage: v.stage,
    value: measure.value(v),
    status: v.status,
  }));
  return (
    <figure className="flex min-w-0 flex-col gap-2" data-testid="stage-chart">
      <figcaption className="text-sm font-medium">{measure.title}</figcaption>
      <div style={{ height: data.length * ROW_HEIGHT + 32 }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            layout="vertical"
            margin={{ top: 0, right: 88, bottom: 0, left: 0 }}
            barCategoryGap={0}
          >
            <CartesianGrid horizontal={false} stroke="var(--viz-grid)" />
            <XAxis
              type="number"
              tickFormatter={(n: number) => measure.format(n)}
              tick={{ fontSize: 11, fill: 'var(--viz-muted-ink)' }}
              axisLine={{ stroke: 'var(--viz-axis)' }}
              tickLine={false}
              tickCount={4}
            />
            <YAxis
              type="category"
              dataKey="stage"
              width="auto"
              tickFormatter={(stage: string) => {
                const d = data.find((x) => x.stage === stage);
                return d === undefined || hasValue(d)
                  ? stage
                  : `${stage}（${statusMeta[d.status].label}）`;
              }}
              tick={{ fontSize: 12, fill: 'var(--muted-foreground)', fontFamily: 'ui-monospace' }}
              axisLine={{ stroke: 'var(--viz-axis)' }}
              tickLine={false}
            />
            <Tooltip
              cursor={{ fill: 'var(--muted)', opacity: 0.6 }}
              content={(props) => <ChartTooltip {...props} format={measure.format} />}
            />
            <Bar
              dataKey="value"
              fill="var(--viz-series-1)"
              barSize={16}
              radius={[0, 4, 4, 0]}
              isAnimationActive={false}
            >
              <LabelList
                dataKey="stage"
                content={(props) => {
                  const d = data.find((x) => x.stage === props.value);
                  if (d === undefined || !hasValue(d)) return null;
                  const x = Number(props.x) + Number(props.width) + 6;
                  const y = Number(props.y) + Number(props.height) / 2;
                  return (
                    <text x={x} y={y} dy={4} fontSize={11} fill="var(--foreground)">
                      {measure.format(d.value)}
                    </text>
                  );
                }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </figure>
  );
}

function StageTable({ views }: { views: StageView[] }) {
  return (
    <table className="w-full text-xs tabular-nums">
      <thead className="text-muted-foreground">
        <tr className="border-b">
          <th className="py-1.5 text-left font-medium">阶段</th>
          <th className="py-1.5 text-left font-medium">状态</th>
          <th className="py-1.5 text-right font-medium">请求</th>
          <th className="py-1.5 text-right font-medium">input</th>
          <th className="py-1.5 text-right font-medium">output</th>
          <th className="py-1.5 text-right font-medium">cache 读</th>
          <th className="py-1.5 text-right font-medium">cache 写</th>
          <th className="py-1.5 text-right font-medium">花费</th>
          <th className="py-1.5 text-right font-medium">耗时</th>
        </tr>
      </thead>
      <tbody>
        {views.map((v) => (
          <tr key={v.stage} className="border-b last:border-0">
            <td className="py-1.5 font-mono">{v.stage}</td>
            <td className="py-1.5">{statusMeta[v.status].label}</td>
            <td className="py-1.5 text-right">{v.stats.requests}</td>
            <td className="py-1.5 text-right">{v.stats.inputTokens}</td>
            <td className="py-1.5 text-right">{v.stats.outputTokens}</td>
            <td className="py-1.5 text-right">{v.stats.cacheReadTokens}</td>
            <td className="py-1.5 text-right">{v.stats.cacheCreationTokens}</td>
            <td className="py-1.5 text-right">{formatUsd(v.stats.costUsd)}</td>
            <td className="py-1.5 text-right">{formatDuration(v.stats.durationMs)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function StageBars({ views }: { views: StageView[] }) {
  const [table, setTable] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex justify-end">
        <button
          type="button"
          className="text-xs text-muted-foreground underline-offset-2 hover:underline"
          aria-pressed={table}
          onClick={() => {
            setTable(!table);
          }}
        >
          {table ? '显示条形图' : '显示表格'}
        </button>
      </div>
      {table ? (
        <StageTable views={views} />
      ) : (
        // 按所在的框（Sessions 详情或终端旁的抽屉）的宽度排成两栏或一栏，抽屉中每张图都有画条的宽度
        <div className="@container" data-testid="stage-charts">
          <div className="grid grid-cols-1 gap-6 @2xl:grid-cols-2">
            {measures.map((m) => (
              <MeasureChart key={m.title} views={views} measure={m} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
