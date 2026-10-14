import { Link } from 'react-router';
import { type Finding, stageName } from '@/lib/analyses-api';
import { cn } from '@/lib/utils';

const severityLabel: Record<Finding['severity'], string> = { high: '高', medium: '中', low: '低' };
const severityClass: Record<Finding['severity'], string> = {
  high: 'border-critical-muted-border bg-critical-muted text-critical-muted-foreground',
  medium: 'border-warning-border bg-warning text-warning-foreground',
  low: 'border-border bg-muted text-muted-foreground',
};

export function SeverityBadge({ severity }: { severity: Finding['severity'] }) {
  return (
    <span
      className={cn('rounded border px-1.5 py-0.5 text-xs font-medium', severityClass[severity])}
      data-testid="severity"
    >
      {severityLabel[severity]}
    </span>
  );
}

// 一个方面中按阶段与 skill 分组，组内按严重程度
function groups(findings: Finding[]): { label: string; items: Finding[] }[] {
  const order = { high: 0, medium: 1, low: 2 };
  const map = new Map<string, Finding[]>();
  for (const f of findings) {
    const label = [f.stage ?? '不限阶段', f.skill === null ? null : `skill ${f.skill}`]
      .filter((x) => x !== null)
      .join(' · ');
    map.set(label, [...(map.get(label) ?? []), f]);
  }
  return [...map].map(([label, items]) => ({
    label,
    items: items.sort((a, b) => order[a.severity] - order[b.severity]),
  }));
}

function FindingCard({ finding, sessionCount }: { finding: Finding; sessionCount: number }) {
  return (
    <li
      id={`finding-${finding.findingId}`}
      className="flex scroll-mt-4 flex-col gap-2 rounded-md border px-3 py-2"
      data-testid="finding"
    >
      <div className="flex flex-wrap items-center gap-2">
        <SeverityBadge severity={finding.severity} />
        <span className="font-medium">{finding.title}</span>
        <span className="ml-auto font-mono text-xs text-muted-foreground">{finding.findingId}</span>
      </div>
      <p className="text-sm whitespace-pre-wrap">{finding.detail}</p>
      <ul className="flex flex-col gap-1">
        {finding.evidence.map((e, i) => (
          <li key={i} className="flex gap-2 text-xs">
            <Link
              to={`/sessions/${e.sessionId}?seq=${String(e.seq)}`}
              className="shrink-0 font-mono underline"
              data-testid="evidence-link"
            >
              {sessionCount > 1 ? `${e.sessionId.slice(0, 8)} ` : ''}#{e.seq}
            </Link>
            <q className="min-w-0 break-words text-muted-foreground">{e.quote}</q>
          </li>
        ))}
      </ul>
    </li>
  );
}

// Contracts 15.3、19.2：发现按方面（session-analysis 的小阶段）、被分析 workflow 的阶段、skill 分组
export function FindingsReport({
  findings,
  aspects,
  sessionCount,
}: {
  findings: Finding[];
  aspects: readonly string[];
  sessionCount: number;
}) {
  return (
    <section aria-label="发现" className="flex flex-col gap-4" data-testid="findings">
      <h2 className="text-lg font-semibold">发现</h2>
      {aspects.map((aspect) => {
        const items = findings.filter((f) => f.aspect === aspect);
        return (
          <section
            key={aspect}
            aria-label={stageName(aspect)}
            className="flex flex-col gap-3 rounded-lg border px-4 py-3"
            data-testid={`aspect-${aspect}`}
          >
            <h3 className="font-medium">
              {stageName(aspect)}
              <span className="ml-2 font-mono text-xs font-normal text-muted-foreground">
                {aspect}
              </span>
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {items.length} 条
              </span>
            </h3>
            {items.length === 0 ? (
              <p className="text-sm text-muted-foreground">没有发现。</p>
            ) : (
              groups(items).map((g) => (
                <div key={g.label} className="flex flex-col gap-2">
                  <h4 className="text-xs font-medium text-muted-foreground">{g.label}</h4>
                  <ul className="flex flex-col gap-2">
                    {g.items.map((f) => (
                      <FindingCard key={f.findingId} finding={f} sessionCount={sessionCount} />
                    ))}
                  </ul>
                </div>
              ))
            )}
          </section>
        );
      })}
    </section>
  );
}
