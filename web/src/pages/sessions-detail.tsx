import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, LoaderCircle, Sparkles } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { RequestTimeline } from '@/components/sessions/request-timeline';
import { StageBars } from '@/components/sessions/stage-bars';
import { StageDetail } from '@/components/sessions/stage-detail';
import { StageGraph } from '@/components/sessions/stage-graph';
import { SessionSummaryPanel } from '@/components/sessions/session-summary';
import { Button } from '@/components/ui/button';
import { formatInteger, formatUsd } from '@/lib/format';
import {
  analyzeSession,
  sessionQuery,
  stagesQuery,
  useSessionEvents,
  type SessionDetail,
  type StageReport,
  type Workflow,
  type WorkflowCycle,
} from '@/lib/sessions-api';
import { cycleName } from '@/lib/stage-status';

function Elapsed() {
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);
  return <>{Math.round((now - start) / 1000)}</>;
}

function AnalyzePanel({ session }: { session: SessionDetail }) {
  const client = useQueryClient();
  const analyze = useMutation({
    mutationFn: () => analyzeSession(session.id),
    onSuccess: (report) => {
      client.setQueryData(stagesQuery(session.id).queryKey, report);
      void client.invalidateQueries({ queryKey: ['session', session.id] });
      void client.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
  if (analyze.isPending)
    return (
      <div
        role="status"
        className="flex flex-col gap-2 rounded-lg border px-4 py-4"
        data-testid="analyze-progress"
      >
        <p className="flex items-center gap-2 text-sm">
          <LoaderCircle className="size-4 animate-spin" />
          正在判定阶段… 已用 <Elapsed /> 秒
        </p>
        <div className="h-1 overflow-hidden rounded bg-muted">
          <div className="h-full w-1/3 animate-[progress_1.4s_ease-in-out_infinite] rounded bg-[var(--viz-series-1)]" />
        </div>
        <p className="text-xs text-muted-foreground">
          /ic 由 Haiku 逐批判定，长 session 需要一两分钟。
        </p>
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed px-4 py-4">
      <p className="text-sm">还没有判定阶段。</p>
      <Button
        onClick={() => {
          analyze.mutate();
        }}
      >
        <Sparkles />
        分析阶段
      </Button>
      <p className="text-xs text-muted-foreground">
        /lfg 按产物文件判定；/ic 调用 Haiku 判定，会产生少量花费。
      </p>
      {analyze.isError && (
        <p role="alert" className="w-full text-sm text-destructive">
          判定失败：{analyze.error.message}
        </p>
      )}
    </div>
  );
}

function ChecksCost({ checks }: { checks: StageReport['checks'] }) {
  return (
    <p className="text-xs text-muted-foreground tabular-nums" data-testid="checks-cost">
      判定花费：
      {checks.count === 0
        ? '没有调用模型'
        : `${formatInteger(checks.count)} 次模型调用 · input ${formatInteger(checks.inputTokens)} · output ${formatInteger(checks.outputTokens)} · ${formatUsd(checks.costUsd)}`}
    </p>
  );
}

const workflowTitle: Record<Workflow, string> = {
  lfg: '/lfg 阶段',
  ic: '/ic 阶段',
};

function parseSelection(value: string | null): { workflow: Workflow; stage: string } | null {
  if (value === null) return null;
  const [workflow, stage] = value.split(':');
  if ((workflow !== 'lfg' && workflow !== 'ic') || stage === undefined) return null;
  return { workflow, stage };
}

function cycleRange(c: WorkflowCycle): string {
  return `#${String(c.startSeq)} – ${c.endSeq === null ? '未结束' : `#${String(c.endSeq)}`}`;
}

// 一个 workflow 的轮次切换：标签取工单编号或 PR 编号
function CycleTabs({
  workflow,
  cycles,
  selected,
  onSelect,
}: {
  workflow: Workflow;
  cycles: WorkflowCycle[];
  selected: number;
  onSelect: (index: number) => void;
}) {
  return (
    <div
      role="tablist"
      aria-label={`/${workflow} 的轮次`}
      className="flex flex-wrap gap-1"
      data-testid={`cycles-${workflow}`}
    >
      {cycles.map((c) => (
        <button
          key={c.index}
          type="button"
          role="tab"
          aria-selected={c.index === selected}
          className="flex flex-col items-start rounded-md border px-3 py-1.5 text-left aria-selected:border-foreground aria-selected:bg-foreground aria-selected:text-background"
          onClick={() => {
            onSelect(c.index);
          }}
        >
          <span className="text-sm font-medium">{cycleName(c)}</span>
          <span className="text-xs tabular-nums opacity-70">{cycleRange(c)}</span>
        </button>
      ))}
    </div>
  );
}

function StagesSection({ session, report }: { session: SessionDetail; report: StageReport }) {
  const [params, setParams] = useSearchParams();
  const selection = parseSelection(params.get('stage'));
  const detailRef = useRef<HTMLDivElement>(null);
  const update = (change: (next: URLSearchParams) => void) => {
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        change(next);
        return next;
      },
      { replace: true },
    );
  };
  // 每个 workflow 选中的轮次，默认第 1 轮
  const cycleOf = (workflow: Workflow): WorkflowCycle | undefined => {
    const cycles = report[workflow];
    const index = Number(params.get(workflow) ?? '1');
    return cycles.find((c) => c.index === index) ?? cycles[0];
  };
  const select = (workflow: Workflow, stage: string) => {
    update((next) => {
      next.set('stage', `${workflow}:${stage}`);
    });
    requestAnimationFrame(() => {
      detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };
  const selectCycle = (workflow: Workflow, index: number) => {
    update((next) => {
      next.set(workflow, String(index));
      if (parseSelection(next.get('stage'))?.workflow === workflow) next.delete('stage');
    });
  };
  const clear = () => {
    update((next) => {
      next.delete('stage');
    });
  };
  const graphs = (['lfg', 'ic'] as const).flatMap((w) => {
    const cycle = cycleOf(w);
    return cycle === undefined ? [] : [{ workflow: w, cycle }];
  });
  const selectedView =
    selection === null
      ? undefined
      : cycleOf(selection.workflow)?.stages.find((v) => v.stage === selection.stage);

  return (
    <>
      <ChecksCost checks={report.checks} />
      {graphs.length === 0 && (
        <p className="rounded-lg border border-dashed px-4 py-4 text-sm text-muted-foreground">
          这个 session 不含 /lfg 或 /ic 的任何一轮，下面列出全部请求。
        </p>
      )}
      {graphs.map(({ workflow, cycle }) => (
        <section
          key={workflow}
          aria-label={workflowTitle[workflow]}
          className="flex flex-col gap-4 rounded-lg border px-4 py-4"
          data-testid={`workflow-${workflow}`}
        >
          <div className="flex flex-wrap items-center gap-4">
            <h2 className="text-base font-semibold">{workflowTitle[workflow]}</h2>
            <CycleTabs
              workflow={workflow}
              cycles={report[workflow]}
              selected={cycle.index}
              onSelect={(index) => {
                selectCycle(workflow, index);
              }}
            />
          </div>
          <StageGraph
            key={cycle.index}
            workflow={workflow}
            views={cycle.stages}
            selected={selection?.workflow === workflow ? selection.stage : null}
            onSelect={(stage) => {
              select(workflow, stage);
            }}
          />
          <StageBars views={cycle.stages} />
        </section>
      ))}
      <div ref={detailRef} className="scroll-mt-4">
        {selection !== null && selectedView !== undefined ? (
          <div className="flex flex-col gap-3">
            <Button variant="outline" size="sm" className="self-start" onClick={clear}>
              查看全部请求
            </Button>
            <StageDetail
              sessionId={session.id}
              workflow={selection.workflow}
              cycle={cycleOf(selection.workflow)}
              view={selectedView}
              subagents={session.subagents}
            />
          </div>
        ) : (
          <AllRequests session={session} hint={graphs.length > 0} />
        )}
      </div>
    </>
  );
}

function AllRequests({ session, hint }: { session: SessionDetail; hint: boolean }) {
  return (
    <section aria-label="全部请求" className="flex flex-col gap-3">
      <h2 className="text-base font-semibold">
        全部请求
        {hint && (
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            点击阶段框只看该阶段的请求
          </span>
        )}
      </h2>
      <RequestTimeline sessionId={session.id} range={{}} subagents={session.subagents} />
    </section>
  );
}

function SessionView({ session }: { session: SessionDetail }) {
  const stages = useQuery(stagesQuery(session.id));
  return (
    <div className="flex flex-col gap-6">
      <SessionSummaryPanel session={session} outside={stages.data?.outside ?? null} />
      {stages.isPending ? (
        <p className="text-sm text-muted-foreground">正在读取阶段判定…</p>
      ) : stages.isError ? (
        <p role="alert" className="text-sm text-destructive">
          读取阶段判定失败：{stages.error.message}
        </p>
      ) : stages.data === null ? (
        <>
          <AnalyzePanel session={session} />
          <AllRequests session={session} hint={false} />
        </>
      ) : (
        <StagesSection session={session} report={stages.data} />
      )}
    </div>
  );
}

export function SessionDetailPage() {
  useSessionEvents();
  const { id } = useParams();
  if (id === undefined) throw new Error('路由缺少 session id');
  const session = useQuery(sessionQuery(id));
  return (
    <div className="flex flex-col gap-4">
      <Link
        to="/sessions"
        className="inline-flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        全部 session
      </Link>
      {session.isPending ? (
        <p className="text-sm text-muted-foreground">正在加载 session…</p>
      ) : session.isError ? (
        <p role="alert" className="text-sm text-destructive">
          加载 session 失败：{session.error.message}
        </p>
      ) : (
        <SessionView session={session.data} />
      )}
    </div>
  );
}
