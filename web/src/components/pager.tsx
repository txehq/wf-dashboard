import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatInteger } from '@/lib/format';

const pageCount = (total: number, pageSize: number) => Math.max(1, Math.ceil(total / pageSize));

// Pagination: the index range of this page and the total, with previous and next icon buttons; sits on one row with the search box and similar controls
export function Pager({
  page,
  pageSize,
  total,
  unit,
  label,
  onPage,
  testId,
}: {
  page: number;
  pageSize: number;
  total: number;
  // Noun after the total, already pluralised for it, for example "sessions"
  unit: string;
  // Accessible name, for example "Session pages"
  label: string;
  onPage: (page: number) => void;
  testId: string;
}) {
  const last = pageCount(total, pageSize);
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <nav
      aria-label={label}
      className="flex shrink-0 items-center gap-1 text-sm"
      data-testid={testId}
    >
      <span className="text-muted-foreground tabular-nums" data-testid={`${testId}-range`}>
        {total > pageSize
          ? `${formatInteger(from)}–${formatInteger(to)} of ${formatInteger(total)} ${unit}`
          : `${formatInteger(total)} ${unit}`}
      </span>
      {total > pageSize && (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Previous page"
            title="Previous page"
            disabled={page <= 1}
            onClick={() => {
              onPage(page - 1);
            }}
          >
            <ChevronLeft />
          </Button>
          <span className="tabular-nums" data-testid={`${testId}-page`}>
            {page} / {last}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Next page"
            title="Next page"
            disabled={page >= last}
            onClick={() => {
              onPage(page + 1);
            }}
          >
            <ChevronRight />
          </Button>
        </>
      )}
    </nav>
  );
}
