import {
  ClipboardCheck,
  ExternalLink,
  FileText,
  GitPullRequest,
  MessageSquareWarning,
} from 'lucide-react';
import { useState } from 'react';
import { MarkdownDoc } from '@/components/markdown-doc';
import { formatTime } from '@/lib/format';
import type { Artifact, RunDetail } from '@/lib/runs-api';
import { cn } from '@/lib/utils';

const docLabel = {
  brief: 'Brief',
  research: 'Research',
  plan: 'Plan（锁定后的文档）',
  tickets: 'Tickets',
} as const;
type DocKind = keyof typeof docLabel;

const isDoc = (a: Artifact): a is Artifact & { kind: DocKind } => a.kind in docLabel;

const updated = (a: Artifact) => formatTime(new Date(a.updatedAt).toISOString());

interface PrState {
  number?: number;
  isDraft?: boolean;
  state?: string;
}

function prText(a: Artifact): string {
  if (a.snapshot === null) return a.location;
  const s = JSON.parse(a.snapshot) as PrState;
  const parts = [s.number === undefined ? null : `#${String(s.number)}`, s.state ?? null];
  if (s.isDraft === true) parts.push('草稿');
  return parts.filter((p) => p !== null).join(' · ');
}

// 验收报告的快照为 { title, toolCallId }
function acceptanceText(a: Artifact): string {
  if (a.snapshot === null) return a.location;
  return (JSON.parse(a.snapshot) as { title: string }).title;
}

function LinkRow({
  href,
  icon: Icon,
  title,
  detail,
}: {
  href: string;
  icon: typeof FileText;
  title: string;
  detail: string;
}) {
  return (
    <li>
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted"
      >
        <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <span className="font-medium">{title}</span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">{detail}</span>
        <ExternalLink className="ml-auto size-3.5 shrink-0" aria-hidden />
      </a>
    </li>
  );
}

// 产物：出现即列出；文档点击后在下方渲染，其余是外部链接
export function RunArtifacts({ run }: { run: RunDetail }) {
  const docs = run.artifacts.filter(isDoc);
  const [open, setOpen] = useState<DocKind | null>(null);
  const shown = docs.find((d) => d.kind === open) ?? null;
  const pr = run.artifacts.find((a) => a.kind === 'pr');
  const acceptance = run.artifacts.find((a) => a.kind === 'acceptance');
  const links = pr !== undefined || acceptance !== undefined || run.friction.length > 0;
  const empty = docs.length === 0 && !links;
  return (
    <section
      className="flex flex-col gap-3 rounded-lg border px-4 py-3"
      aria-labelledby="artifacts-title"
      data-testid="run-artifacts"
    >
      <h2 id="artifacts-title" className="text-sm font-medium">
        产物
      </h2>
      {empty && (
        <p className="text-sm text-muted-foreground">
          {run.taskKind === 'lfg'
            ? 'Brief、Research、Tickets 写出后出现在这里。'
            : 'PR 与验收报告出现后列在这里。'}
        </p>
      )}
      {docs.length > 0 && (
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="产物文档">
          {docs.map((d) => (
            <button
              key={d.kind}
              type="button"
              role="tab"
              aria-selected={open === d.kind}
              className={cn(
                'flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm hover:bg-muted',
                open === d.kind && 'border-foreground bg-muted font-medium',
              )}
              onClick={() => {
                setOpen(open === d.kind ? null : d.kind);
              }}
            >
              <FileText className="size-4" aria-hidden />
              {docLabel[d.kind]}
              <span className="text-xs font-normal text-muted-foreground">{updated(d)}</span>
            </button>
          ))}
        </div>
      )}
      {links && (
        <ul className="flex flex-col">
          {pr !== undefined && (
            <LinkRow href={pr.location} icon={GitPullRequest} title="PR" detail={prText(pr)} />
          )}
          {acceptance !== undefined && (
            <LinkRow
              href={acceptance.location}
              icon={ClipboardCheck}
              title="验收报告"
              detail={acceptanceText(acceptance)}
            />
          )}
          {run.friction.map((f) => (
            <LinkRow
              key={f.url}
              href={f.url}
              icon={MessageSquareWarning}
              title="friction issue"
              detail={f.title}
            />
          ))}
        </ul>
      )}
      {shown !== null && (
        <div className="flex flex-col gap-1">
          <p className="truncate font-mono text-xs text-muted-foreground" title={shown.location}>
            {shown.location}
          </p>
          {shown.snapshot === null ? (
            <p className="text-sm text-muted-foreground">没有内容快照。</p>
          ) : (
            <MarkdownDoc content={shown.snapshot} className="max-h-[640px]" />
          )}
        </div>
      )}
    </section>
  );
}
