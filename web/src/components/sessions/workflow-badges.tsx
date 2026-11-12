// Workflows the dashboard records (Contracts 25.4): the workflow of the variant a variant-config session belongs to
export function WorkflowBadges({ workflows }: { workflows: string[] }) {
  if (workflows.length === 0) return <span className="text-sm text-muted-foreground">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
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

// Workflow of design and optimize sessions (Contracts 33.3): the built-in workflow-design and
// workflow-optimize, shown by name
const purposeLabel = { design: 'Design workflow', optimize: 'Optimize' } as const;

export function PurposeBadge({ purpose }: { purpose: 'design' | 'optimize' }) {
  return (
    <span
      className="rounded border bg-muted px-1.5 py-0.5 text-xs font-medium"
      data-testid="purpose-badge"
    >
      {purposeLabel[purpose]}
    </span>
  );
}
