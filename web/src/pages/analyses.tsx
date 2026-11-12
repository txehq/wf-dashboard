import { useQuery } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import {
  analysesQuery,
  costText,
  engineLabel,
  statusLabel,
  useAnalysisEvents,
} from '@/lib/analyses-api';

// Contracts 15.3, 19: analysis list
export function AnalysesPage() {
  useAnalysisEvents();
  const list = useQuery(analysesQuery);
  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">Analyses</h1>
          <p className="text-sm text-muted-foreground">
            Analyze sessions with a variant of the session-analysis workflow, then save skill
            changes based on the findings as a new variant, or hand the report to Codex or Claude
            Code to optimize.
          </p>
        </div>
        <Button asChild className="ml-auto" data-testid="new-analysis">
          <Link to="/analyses/new">
            <Plus />
            New analysis
          </Link>
        </Button>
      </header>
      {list.isPending ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : list.isError ? (
        <p role="alert" className="text-sm text-destructive">
          Couldn't load analyses: {list.error.message}
        </p>
      ) : list.data.length === 0 ? (
        <p className="rounded-lg border border-dashed py-12 text-center text-sm text-muted-foreground">
          No analyses yet.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-lg border">
          <table className="w-full text-left text-sm">
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th className="py-2 pr-4 pl-3 font-medium">Analysis</th>
                <th className="py-2 pr-4 font-medium">Scope</th>
                <th className="py-2 pr-4 font-medium">Variant</th>
                <th className="py-2 pr-4 font-medium">Engine</th>
                <th className="py-2 pr-4 font-medium">Status</th>
                <th className="py-2 pr-3 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((a) => (
                <tr key={a.id} className="border-b last:border-0" data-testid="analysis-row">
                  <td className="py-2 pr-4 pl-3">
                    <Link className="font-mono font-medium underline" to={`/analyses/${a.id}`}>
                      {a.id}
                    </Link>
                    <p className="text-xs text-muted-foreground">{formatDateTime(a.createdAt)}</p>
                  </td>
                  <td className="py-2 pr-4 font-mono text-xs">
                    {a.sessionIds.length === 1
                      ? (a.sessionIds[0] ?? '').slice(0, 8)
                      : `${String(a.sessionIds.length)} sessions`}
                  </td>
                  <td className="py-2 pr-4">
                    {a.variantName ?? 'Local config'}
                    {a.analysisVariantName !== null && (
                      <p className="text-xs text-muted-foreground">
                        Method {a.analysisVariantName}
                      </p>
                    )}
                  </td>
                  <td className="py-2 pr-4">
                    {engineLabel[a.engine]}
                    <p className="font-mono text-xs text-muted-foreground">{a.model}</p>
                  </td>
                  <td className="py-2 pr-4">{statusLabel[a.status]}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{costText(a)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
