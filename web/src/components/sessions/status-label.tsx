import type { StageStatus } from '@/lib/sessions-api';
import { statusMeta } from '@/lib/stage-status';

export function StatusLabel({ status }: { status: StageStatus }) {
  const { label, icon: Icon, iconClass } = statusMeta[status];
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <Icon className={`size-3.5 ${iconClass}`} aria-hidden />
      {label}
    </span>
  );
}
