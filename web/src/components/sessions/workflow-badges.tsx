import { Link } from 'react-router';
import type { Workflow } from '@/lib/sessions-api';

// 交互产生或被交互 resume 的 session（Contracts 14.1）：链接到交互区的标签页
export function LiveBadge({ liveId }: { liveId: string }) {
  return (
    <Link
      to={`/live?open=${liveId}`}
      className="relative z-10 rounded border border-sky-300 bg-sky-50 px-1.5 py-0.5 text-xs font-medium text-sky-900 hover:underline"
      data-testid="live-badge"
      title={liveId}
    >
      交互
    </Link>
  );
}

export function WorkflowBadges({ workflows }: { workflows: Workflow[] }) {
  if (workflows.length === 0) return <span className="text-sm text-muted-foreground">—</span>;
  return (
    <span className="flex gap-1">
      {workflows.map((w) => (
        <span
          key={w}
          className="rounded border bg-background px-1.5 py-0.5 font-mono text-xs font-medium"
        >
          /{w}
        </span>
      ))}
    </span>
  );
}
