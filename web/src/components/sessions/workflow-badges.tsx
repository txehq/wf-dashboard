import type { Workflow } from '@/lib/sessions-api';

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
