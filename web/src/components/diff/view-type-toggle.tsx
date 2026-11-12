import type { ViewType } from 'react-diff-view';
import { cn } from '@/lib/utils';
import { useDiffViewType } from './view-type';

const labels: [ViewType, string][] = [
  ['unified', 'Unified'],
  ['split', 'Side by side'],
];

export function DiffViewTypeToggle({ className }: { className?: string }) {
  const [viewType, setViewType] = useDiffViewType();
  return (
    <div
      role="group"
      aria-label="Diff layout"
      className={cn('inline-flex overflow-hidden rounded-md border text-xs', className)}
      data-testid="diff-view-type"
      data-view={viewType}
    >
      {labels.map(([value, label]) => (
        <button
          key={value}
          type="button"
          aria-pressed={viewType === value}
          className="px-2.5 py-1 hover:bg-muted aria-pressed:bg-foreground aria-pressed:text-background"
          onClick={() => {
            setViewType(value);
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
