import { Link } from 'react-router';

// 交互产生或被交互 resume 的 session（Contracts 14.1）：链接到交互区的标签页
export function LiveBadge({ liveId }: { liveId: string }) {
  return (
    <Link
      to={`/live?item=${liveId}`}
      className="relative z-10 rounded border border-info-border bg-info px-1.5 py-0.5 text-xs font-medium text-info-foreground hover:underline"
      data-testid="live-badge"
      title={liveId}
    >
      交互
    </Link>
  );
}

// dashboard 记录的 workflow（Contracts 25.4）：variant 配置下的 session 所属 variant 的 workflow
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

const purposeLabel = { design: '设计', optimize: '优化' } as const;

// 设计与优化下的 session 显示它的用途（Contracts 25.4）
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
