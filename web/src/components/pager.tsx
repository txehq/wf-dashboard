import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatInteger } from '@/lib/format';

const pageCount = (total: number, pageSize: number) => Math.max(1, Math.ceil(total / pageSize));

// 分页：显示这一页的序号范围与总数，前后翻页的图标按钮；与搜索框等放在同一行
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
  // 计数的单位，例如"个 session"
  unit: string;
  // 读屏用的名字，例如"session 的分页"
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
          ? `${formatInteger(from)}–${formatInteger(to)}，共 ${formatInteger(total)} ${unit}`
          : `共 ${formatInteger(total)} ${unit}`}
      </span>
      {total > pageSize && (
        <>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="上一页"
            title="上一页"
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
            aria-label="下一页"
            title="下一页"
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
