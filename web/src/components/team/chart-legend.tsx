// The legend of every Team chart, the same in the Linear and txe PRs views (Contracts 37.6)

export interface LegendItem {
  key: string;
  label: string;
  color: string;
  title?: string;
}

// A square for bars, a short stroke for lines
export function ChartLegend({
  items,
  mark = 'bar',
}: {
  items: readonly LegendItem[];
  mark?: 'bar' | 'line';
}) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs" aria-label="Legend">
      {items.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5" title={s.title}>
          <span
            className={mark === 'bar' ? 'size-2.5 rounded-sm' : 'h-0.5 w-3 rounded-full'}
            style={{ background: s.color }}
          />
          {s.label}
        </li>
      ))}
    </ul>
  );
}
