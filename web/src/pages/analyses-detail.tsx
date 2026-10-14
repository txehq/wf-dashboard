import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { FindingsReport } from '@/components/analyses/findings-report';
import { PatchReview } from '@/components/analyses/patch-review';
import { EngineChoice } from '@/components/engine-choice';
import { Button } from '@/components/ui/button';
import type { DraftEngine } from '@/lib/drafts-api';
import {
  type AnalysisDetail,
  type AnalysisReport,
  type AnalysisStep,
  analysisQuery,
  aspectKeys,
  cancelAnalysis,
  costText,
  engineLabel,
  outcomeLabel,
  stageName,
  startOptimize,
  statusLabel,
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
              <td className="py-2 pr-4 pl-3">
                {stageName(s.key)}
                <span className="ml-2 font-mono text-xs text-muted-foreground">{s.key}</span>
              </td>
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

// 引用的发现：链接到页面中对应的卡片
function FindingRefs({ ids }: { ids: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {ids.map((id) => (
        <a key={id} href={`#finding-${id}`} className="font-mono text-xs underline">
          {id}
        </a>
      ))}
    </span>
  );
}

// synthesize 写出的报告（Contracts 19.2）：总结、目标与结果、每个方面的条数、影响最大的问题、需要新建 workflow 的建议
function ReportSummary({ analysis, report }: { analysis: AnalysisDetail; report: AnalysisReport }) {
  return (
    <section
      aria-label="报告"
      className="flex flex-col gap-3 rounded-lg border px-4 py-3"
      data-testid="analysis-report"
    >
      <h2 className="text-lg font-semibold">报告</h2>
      <p className="text-sm whitespace-pre-wrap">{report.summary}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">目标</dt>
        <dd>{report.goal}</dd>
        <dt className="text-muted-foreground">结果</dt>
        <dd data-testid="analysis-outcome">{outcomeLabel[report.outcome]}</dd>
        <dt className="text-muted-foreground">发现</dt>
        <dd className="flex flex-wrap gap-x-3">
          {aspectKeys(analysis.steps).map((a) => (
            <span key={a}>
              {stageName(a)} {analysis.findings.filter((f) => f.aspect === a).length}
            </span>
          ))}
        </dd>
      </dl>
      {report.topIssues.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">影响最大的问题</h3>
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-sm">
            {report.topIssues.map((issue, i) => (
              <li key={i}>
                <span className="font-medium">{issue.title}</span>：{issue.impact}{' '}
                <FindingRefs ids={issue.findingIds} />
              </li>
            ))}
          </ol>
        </div>
      )}
      {report.workflowChanges.length > 0 && (
        <div className="flex flex-col gap-1" data-testid="workflow-changes">
          <h3 className="text-sm font-medium">需要新建 workflow 的修改（改入口或小阶段）</h3>
          <ul className="flex flex-col gap-1 text-sm">
            {report.workflowChanges.map((c, i) => (
              <li key={i}>
                {c.change}（{c.rationale}） <FindingRefs ids={c.findingIds} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

// "优化"（Contracts 19.3、22.1）：选引擎后在 Live 中建会话，工作目录为分析目录，跳到它；每次打开默认 Codex
function OptimizeButton({ analysis }: { analysis: AnalysisDetail }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [choosing, setChoosing] = useState(false);
  const [engine, setEngine] = useState<DraftEngine>('codex');
  const start = useMutation({
    mutationFn: () => startOptimize(analysis.id, engine),
    onSuccess: async ({ live }) => {
      await client.invalidateQueries({ queryKey: ['live'] });
      await navigate(`/live?item=${live.id}`);
    },
  });
  const sessions = analysis.optimizeDrafts.filter((d) => d.liveId !== null);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      {choosing ? (
        <span className="contents" data-testid="analysis-optimize-form">
          <EngineChoice value={engine} onChange={setEngine} />
          <Button
            size="sm"
            data-testid="analysis-optimize-start"
            disabled={start.isPending}
            onClick={() => {
              start.mutate();
            }}
          >
            <Sparkles />
            {start.isPending ? '正在发起…' : '在 Live 中开始'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setChoosing(false);
            }}
          >
            取消
          </Button>
        </span>
      ) : (
        <Button
          size="sm"
          data-testid="analysis-optimize"
          title="把报告交给 agent，判断改 variant 还是新建 workflow，并把改动做出来"
          onClick={() => {
            setEngine('codex');
            setChoosing(true);
          }}
        >
          <Sparkles />
          优化
        </Button>
      )}
      {sessions.map((d) => (
        <Link key={d.id} className="underline" to={`/live?item=${d.liveId ?? ''}`}>
          优化 {d.id}
        </Link>
      ))}
      {start.isError && (
        <p role="alert" className="text-destructive">
          {start.error.message}
        </p>
      )}
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
          {analysis.analysisVariantId !== null && (
            <>
              · 分析方法{' '}
              <Link
                className="underline"
                to={`/variants/${analysis.analysisVariantId}`}
                data-testid="analysis-method"
              >
                {analysis.analysisVariantName}
              </Link>{' '}
            </>
          )}
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
      {analysis.report !== null && <ReportSummary analysis={analysis} report={analysis.report} />}
      {analysis.status === 'succeeded' && analysis.report !== null && (
        <OptimizeButton analysis={analysis} />
      )}
      {analysis.findings.length > 0 && (
        <FindingsReport
          findings={analysis.findings}
          aspects={aspectKeys(analysis.steps)}
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
