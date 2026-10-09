import {
  Ban,
  CheckCircle2,
  Clock,
  LoaderCircle,
  PlayCircle,
  Scale,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { type RunStatus, statusLabel } from '@/lib/runs-api';
import { cn } from '@/lib/utils';

// 状态由图标与文字区分，颜色只是附加
const meta: Record<RunStatus, { icon: LucideIcon; className: string }> = {
  queued: { icon: Clock, className: 'text-muted-foreground' },
  preparing: { icon: LoaderCircle, className: 'animate-spin text-[var(--viz-series-1)]' },
  running: { icon: PlayCircle, className: 'text-[var(--viz-series-1)]' },
  grading: { icon: Scale, className: 'text-[var(--viz-series-1)]' },
  succeeded: { icon: CheckCircle2, className: 'text-[var(--viz-status-good-text)]' },
  failed: { icon: XCircle, className: 'text-[var(--status-critical)]' },
  cancelled: { icon: Ban, className: 'text-muted-foreground' },
};

export function RunStatusLabel({ status, className }: { status: RunStatus; className?: string }) {
  const { icon: Icon, className: iconClass } = meta[status];
  return (
    <span
      className={cn('inline-flex items-center gap-1 text-xs whitespace-nowrap', className)}
      data-testid="run-status"
      data-status={status}
    >
      <Icon className={cn('size-3.5 shrink-0', iconClass)} aria-hidden />
      {statusLabel[status]}
    </span>
  );
}
