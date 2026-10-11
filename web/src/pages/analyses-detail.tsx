import { useMutation, useQuery } from '@tanstack/react-query';
import { ArrowLeft } from 'lucide-react';
import { Link, useParams } from 'react-router';
import { FindingsReport } from '@/components/analyses/findings-report';
import { PatchReview } from '@/components/analyses/patch-review';
import { Button } from '@/components/ui/button';
import {
  type AnalysisDetail,
  type AnalysisStep,
  analysisQuery,
  cancelAnalysis,
  costText,
  engineLabel,
  statusLabel,
  stepLabel,
  tokenTotal,
  useAnalysisEvents,
} from '@/lib/analyses-api';
import { formatCount, formatDateTime, formatDuration, formatUsd } from '@/lib/format';
import { useNow } from '@/lib/use-now';

const stepStatus: Record<AnalysisStep['status'], string> = {
  pending: '等待',
  running: '进行中',
  succeeded: '完成',
  failed: '失败',
  cancelled: '已停止',
};

function Steps({ analysis }: { analysis: AnalysisDetail }) {
  const now = useNow(analysis.status === 'running');
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-left text-sm" data-testid="analysis-steps">
        <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
          <tr>
            <th className="py-2 pr-4 pl-3 font-medium">步骤</th>
            <th className="py-2 pr-4 font-medium">状态</th>
            <th className="py-2 pr-4 text-right font-medium">耗时</th>
            <th className="py-2 pr-4 text-right font-medium">事件</th>
            <th className="py-2 pr-4 text-right font-medium">token</th>
            <th className="py-2 pr-3 text-right font-medium">花费</th>
          </tr>
        </thead>
        <tbody>
          {analysis.steps.map((s) => (
            <tr
              key={s.key}
              className="border-b align-top last:border-0"
              data-testid="analysis-step"
            >
              <td className="py-2 pr-4 pl-3">{stepLabel[s.key]}</td>
              <td className="py-2 pr-4">
                {stepStatus[s.status]}
                {s.error !== null && (
                  <pre className="mt-1 max-h-48 overflow-auto text-xs whitespace-pre-wrap text-destructive">
                    {s.error}
                  </pre>
                )}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">
                {s.startedAt === null ? '—' : formatDuration((s.endedAt ?? now) - s.startedAt)}
              </td>
              <td className="py-2 pr-4 text-right tabular-nums">{s.events}</td>
              <td
                className="py-2 pr-4 text-right tabular-nums"
                title={`input ${String(s.tokens.input)} · output ${String(s.tokens.output)} · cache 读 ${String(s.tokens.cacheRead)} · cache 写 ${String(s.tokens.cacheWrite)} · reasoning ${String(s.tokens.reasoning)}`}
              >
                {formatCount(tokenTotal(s.tokens))}
              </td>
              <td className="py-2 pr-3 text-right tabular-nums">
                {s.costUsd === null ? '—' : formatUsd(s.costUsd)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AnalysisView({ analysis }: { analysis: AnalysisDetail }) {
  const cancel = useMutation({ mutationFn: () => cancelAnalysis(analysis.id) });
  const live = analysis.status === 'queued' || analysis.status === 'running';
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-2xl font-semibold">{analysis.id}</h1>
          <span className="rounded bg-muted px-2 py-0.5 text-sm" data-testid="analysis-status">
            {statusLabel[analysis.status]}
          </span>
          {live && (
            <Button
              variant="outline"
              size="sm"
              disabled={cancel.isPending}
              onClick={() => {
                cancel.mutate();
              }}
            >
              取消
            </Button>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          {engineLabel[analysis.engine]} · <span className="font-mono">{analysis.model}</span> ·
          variant{' '}
          <Link className="underline" to={`/variants/${analysis.variantId}`}>
            {analysis.variantName}
          </Link>{' '}
          · {formatDateTime(analysis.createdAt)} · {costText(analysis)}
        </p>
        <ul className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {analysis.sessions.map((s) => (
            <li key={s.id}>
              <Link className="underline" to={`/sessions/${s.id}`}>
                {s.title ?? s.id.slice(0, 8)}
              </Link>
              <span className="ml-1 font-mono text-xs text-muted-foreground">
                {s.id.slice(0, 8)}
                {s.runId !== null && ` · ${s.runId}`}
              </span>
            </li>
          ))}
        </ul>
        {cancel.isError && (
          <p role="alert" className="text-sm text-destructive">
            {cancel.error.message}
          </p>
        )}
      </header>
      <Steps analysis={analysis} />
      {analysis.error !== null && (
        <pre
          role="alert"
          className="max-h-64 overflow-auto rounded-md border border-destructive/40 px-3 py-2 text-xs whitespace-pre-wrap text-destructive"
        >
          {analysis.error}
        </pre>
      )}
      {analysis.findings.length > 0 && (
        <FindingsReport
          findings={analysis.findings}
          aspects={['process', 'efficiency', 'interaction', 'quality']}
          sessionCount={analysis.sessions.length}
        />
      )}
      {analysis.status === 'succeeded' && (
        <PatchReview
          analysisId={analysis.id}
          files={analysis.files}
          findings={analysis.findings}
          patches={analysis.patches}
        />
      )}
    </div>
  );
}

export function AnalysisDetailPage() {
  useAnalysisEvents();
  const { id } = useParams();
  if (id === undefined) throw new Error('路由缺少分析 id');
  const analysis = useQuery(analysisQuery(id));
  return (
    <div className="flex flex-col gap-4">
      <Link
        to="/analyses"
        className="inline-flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        全部分析
      </Link>
      {analysis.isPending ? (
        <p className="text-sm text-muted-foreground">正在加载…</p>
      ) : analysis.data === undefined ? (
        <p role="alert" className="text-sm text-destructive">
          加载分析失败：{analysis.error.message}
        </p>
      ) : (
        <AnalysisView analysis={analysis.data} />
      )}
    </div>
  );
}
