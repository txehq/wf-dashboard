import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Ban,
  CircleSlash,
  ExternalLink,
  Hand,
  Link2,
  TriangleAlert,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Conversation } from '@/components/runs/conversation';
import { RunArtifacts } from '@/components/runs/run-artifacts';
import { RunGradesPanel } from '@/components/runs/run-grades';
import { StageText } from '@/components/runs/run-list';
import { RunStatusLabel } from '@/components/runs/run-status';
import { RequestTimeline, type TimelineFocus } from '@/components/sessions/request-timeline';
import { StageGraph } from '@/components/sessions/stage-graph';
import { Button } from '@/components/ui/button';
import { formatDateTime, formatDuration, formatUsd } from '@/lib/format';
import {
  type CrossRunRef,
  liveStatuses,
  runAction,
  type RunDetail,
  runDuration,
  runQuery,
  setRunInvalid,
  useRunEvents,
} from '@/lib/runs-api';
import { type StageView, sessionQuery, type Workflow } from '@/lib/sessions-api';
import { useNow } from '@/lib/use-now';

const STAGES: Record<Workflow, string[]> = {
  lfg: ['interview', 'research', 'plan', 'ticketing'],
  ic: ['claim', 'readiness', 'implement', 'acceptance', 'open-pr', 'fix-pr', 'ready-for-review'],
};

const emptyStats = {
  requests: 0,
  mainRequests: 0,
  toolCalls: {},
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  costUsd: 0,
  durationMs: 0,
  subagents: 0,
};

// 还没有阶段判定结果时，按 workflow 的阶段列表显示为未到达
function stageViews(run: RunDetail): StageView[] {
  const cycle = run.stages?.[run.taskKind][0];
  if (cycle !== undefined) return cycle.stages;
  return STAGES[run.taskKind].map((stage) => ({
    stage,
    status: 'not-reached',
    startSeq: null,
    endSeq: null,
    method: run.taskKind === 'lfg' ? 'artifact' : 'llm',
    evidence: null,
    stats: emptyStats,
  }));
}

function ExternalLinks({ links }: { links: RunDetail['links'] }) {
  const items = [
    { label: 'Linear 工单', href: links.ticket },
    { label: 'GitHub 仓库', href: links.repo },
    { label: 'PR', href: links.pr },
  ].filter((i): i is { label: string; href: string } => i.href !== null);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm" data-testid="run-links">
      {items.map((i) => (
        <a
          key={i.label}
          href={i.href}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 underline"
        >
          {i.label}
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      ))}
      {links.vault !== null && (
        <span className="inline-flex min-w-0 items-center gap-1">
          vault 目录
          <code className="truncate text-xs text-muted-foreground" title={links.vault}>
            {links.vault}
          </code>
        </span>
      )}
      {items.length === 0 && links.vault === null && (
        <span className="text-muted-foreground">外部对象在准备阶段建立后出现在这里。</span>
      )}
    </div>
  );
}

const costParts = [
  { key: 'agent', label: 'agent' },
  { key: 'simulatedUser', label: '模拟用户' },
  { key: 'stageCheck', label: '阶段判定' },
  { key: 'grading', label: '评分' },
] as const;

function Costs({ costs }: { costs: RunDetail['costs'] }) {
  return (
    <dl className="flex flex-wrap gap-x-6 gap-y-1" data-testid="run-costs">
      {costParts.map((p) => (
        <div key={p.key} className="flex flex-col">
          <dt className="text-xs text-muted-foreground">{p.label}</dt>
          <dd className="tabular-nums">{formatUsd(costs[p.key])}</dd>
        </div>
      ))}
      <div className="flex flex-col">
        <dt className="text-xs text-muted-foreground">合计</dt>
        <dd className="font-semibold tabular-nums">{formatUsd(costs.total)}</dd>
      </div>
    </dl>
  );
}

function Header({ run }: { run: RunDetail }) {
  const live = liveStatuses.has(run.status);
  const now = useNow(live);
  const duration = runDuration(run, now);
  const cancel = useMutation({ mutationFn: () => runAction(run.id, 'cancel') });
  const cancellable = run.status === 'queued' || run.status === 'running';
  return (
    <div className="flex flex-col gap-3 rounded-lg border px-4 py-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold">{run.taskTitle}</h1>
        <RunStatusLabel status={run.status} className="text-sm" />
        {run.status === 'running' && (
          <span className="rounded border px-1.5 py-0.5 text-xs" data-testid="run-mode">
            {run.mode === 'human' ? '人工回答中' : '模拟用户回答中'}
          </span>
        )}
        {run.humanIntervened && (
          <span
            className="inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs"
            data-testid="intervened"
          >
            <Hand className="size-3.5" aria-hidden />
            有人工干预
          </span>
        )}
        {cancellable && (
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            disabled={cancel.isPending}
            onClick={() => {
              if (window.confirm('取消这个 run？取消后不评分，也不能继续。')) cancel.mutate();
            }}
          >
            <Ban />
            {cancel.isPending ? '正在取消…' : '取消运行'}
          </Button>
        )}
      </div>
      <p className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
        <span className="font-mono">{run.id}</span>
        <span>{run.variantName}</span>
        <span>第 {run.repeatIndex + 1} 次</span>
        <span>
          <StageText stage={run.currentStage} />
        </span>
        <span>创建于 {formatDateTime(new Date(run.createdAt).toISOString())}</span>
        {duration !== null && <span>耗时 {formatDuration(duration)}</span>}
      </p>
      {cancel.isError && <p className="text-sm text-destructive">{cancel.error.message}</p>}
      <Validity run={run} />
      <ExternalLinks links={run.links} />
      <Costs costs={run.costs} />
    </div>
  );
}

// Contracts 7.12：评估环境出错的 run 标为无效，保留全部记录，对比时总是排除
function Validity({ run }: { run: RunDetail }) {
  const client = useQueryClient();
  const mark = useMutation({
    mutationFn: (reason: string | null) => setRunInvalid(run.id, reason),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['runs'] });
    },
  });
  if (liveStatuses.has(run.status)) return null;
  return (
    <div className="flex flex-col gap-1">
      {run.invalidReason === null ? (
        <div className="flex items-center gap-3 text-sm">
          <Button
            variant="outline"
            size="sm"
            disabled={mark.isPending}
            onClick={() => {
              const reason = window.prompt(
                '标为无效的原因（例如评估环境出错）。标记后这个 run 不参与对比，记录全部保留。',
              );
              if (reason !== null && reason.trim() !== '') mark.mutate(reason.trim());
            }}
          >
            <CircleSlash />
            标为无效
          </Button>
          <span className="text-xs text-muted-foreground">
            评估环境本身出错、不能代表 variant 的 run 可以标为无效。
          </span>
        </div>
      ) : (
        <div
          className="flex flex-wrap items-center gap-3 rounded-md border border-dashed px-3 py-2 text-sm"
          data-testid="run-invalid"
        >
          <CircleSlash className="size-4" aria-hidden />
          <span className="font-medium">已标为无效，不参与对比：</span>
          <span data-testid="run-invalid-reason">{run.invalidReason}</span>
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={mark.isPending}
            onClick={() => {
              mark.mutate(null);
            }}
          >
            恢复
          </Button>
        </div>
      )}
      {mark.isError && <p className="text-sm text-destructive">{mark.error.message}</p>}
    </div>
  );
}

// Contracts 7.6：评分状态。取消的 run 也按已写出的产物评分
function Grading({ run }: { run: RunDetail }) {
  const { status, error } = run.grading;
  if (status === 'done') return <RunGradesPanel runId={run.id} />;
  if (status === 'running') {
    return (
      <p className="rounded-lg border px-4 py-3 text-sm" data-testid="grading-running">
        {run.status === 'cancelled' ? '正在按取消时已写出的产物评分…' : '正在评分…'}
      </p>
    );
  }
  if (status === 'failed') {
    return (
      <div
        role="alert"
        className="flex flex-col gap-1 rounded-lg border px-4 py-3"
        data-testid="grading-failed"
      >
        <p className="text-sm font-medium">评分出错</p>
        <pre className="font-mono text-xs whitespace-pre-wrap">{error}</pre>
      </div>
    );
  }
  return null;
}

function Failure({ run, views }: { run: RunDetail; views: StageView[] }) {
  if (run.status !== 'failed' || run.error === null) return null;
  const at =
    views.find((v) => v.status === 'active') ??
    [...views].reverse().find((v) => v.status === 'done');
  return (
    <div
      role="alert"
      className="flex flex-col gap-1 rounded-lg border-2 border-[var(--status-critical)] px-4 py-3"
      data-testid="run-error"
    >
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <TriangleAlert className="size-4" aria-hidden />
        run 失败
        {at === undefined
          ? '，还没有进入任何阶段'
          : `，发生在 /${run.taskKind} · ${at.stage}${at.status === 'done' ? ' 之后' : ''}`}
      </p>
      <pre className="font-mono text-xs whitespace-pre-wrap">{run.error}</pre>
    </div>
  );
}

const refKindLabel: Record<CrossRunRef['kind'], string> = {
  repo: '仓库',
  vault: 'vault 目录',
  ticket: 'Linear 工单',
  other: 'run id',
};

// Contracts 7.11：这个 run 的请求中指向其他评估 run 的引用，点击定位到请求流中的那条请求
function CrossRefs({
  refs,
  onFocus,
}: {
  refs: CrossRunRef[];
  onFocus: (ref: CrossRunRef) => void;
}) {
  if (refs.length === 0) return null;
  return (
    <section
      className="flex flex-col gap-2 rounded-lg border-2 border-dashed px-4 py-3"
      aria-labelledby="cross-refs-title"
      data-testid="cross-refs"
    >
      <h2 id="cross-refs-title" className="flex items-center gap-1.5 text-sm font-medium">
        <Link2 className="size-4" aria-hidden />
        参考了其他 run
        <span className="font-normal text-muted-foreground">
          对比时默认排除；共 {refs.length} 处
        </span>
      </h2>
      <ul className="flex flex-col gap-1">
        {refs.map((ref) => (
          <li
            key={`${ref.toolCallId}:${ref.runId}:${ref.kind}`}
            className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm"
          >
            <Link to={`/runs/${ref.runId}`} className="font-mono text-xs underline">
              {ref.runId}
            </Link>
            <span className="text-xs text-muted-foreground">{refKindLabel[ref.kind]}</span>
            <button
              type="button"
              data-testid="cross-ref-jump"
              className="rounded border px-1.5 py-0.5 text-xs hover:bg-muted"
              onClick={() => {
                onFocus(ref);
              }}
            >
              请求 #{ref.requestSeq}
            </button>
            <code className="min-w-0 flex-1 truncate text-xs" title={ref.excerpt}>
              {ref.excerpt}
            </code>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Requests({ run, focus }: { run: RunDetail; focus: TimelineFocus | null }) {
  const session = useQuery({ ...sessionQuery(run.sessionId), retry: false });
  const live = liveStatuses.has(run.status);
  return (
    <section
      className="flex scroll-mt-4 flex-col gap-2"
      aria-labelledby="requests-title"
      id="run-requests"
    >
      <h2 id="requests-title" className="text-sm font-medium">
        请求流
      </h2>
      {session.isPending ? (
        <p className="text-sm text-muted-foreground">加载中…</p>
      ) : session.isError ? (
        <p
          className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground"
          data-testid="requests-empty"
        >
          {live
            ? 'Claude Code 还没有写出 session 记录，通常在启动后几分钟内出现。'
            : '这个 run 没有 session 记录。'}
        </p>
      ) : (
        <RequestTimeline
          sessionId={run.sessionId}
          range={{}}
          subagents={session.data.subagents}
          follow={live}
          focus={focus}
        />
      )}
    </section>
  );
}

function RunView({ run }: { run: RunDetail }) {
  const views = stageViews(run);
  const [selected, setSelected] = useState<string | null>(null);
  const [focus, setFocus] = useState<TimelineFocus | null>(null);
  const live = liveStatuses.has(run.status);
  return (
    <div className="flex flex-col gap-4">
      <Header run={run} />
      <Failure run={run} views={views} />
      <CrossRefs
        refs={run.crossRunRefs}
        onFocus={(ref) => {
          setFocus({ seq: ref.requestSeq, toolCallId: ref.toolCallId, nonce: Date.now() });
          document.getElementById('run-requests')?.scrollIntoView({ behavior: 'smooth' });
        }}
      />
      <section
        className="flex flex-col gap-2 rounded-lg border px-4 py-3"
        aria-label="阶段进度"
        data-testid="run-stages"
      >
        <h2 className="text-sm font-medium">/{run.taskKind} 阶段</h2>
        <StageGraph
          workflow={run.taskKind}
          views={views}
          selected={selected}
          onSelect={(stage) => {
            setSelected(selected === stage ? null : stage);
          }}
          live={live}
        />
      </section>
      <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,5fr)_minmax(0,4fr)]">
        <Conversation run={run} />
        <RunArtifacts run={run} />
      </div>
      <Grading run={run} />
      <Requests run={run} focus={focus} />
    </div>
  );
}

export function RunDetailPage() {
  useRunEvents();
  const { id } = useParams();
  if (id === undefined) throw new Error('路由缺少 run id');
  const run = useQuery(runQuery(id));
  return (
    <div className="flex flex-col gap-4">
      <Link
        to="/runs"
        className="inline-flex items-center gap-1 self-start text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        全部运行
      </Link>
      {run.isPending ? (
        <p className="text-sm text-muted-foreground">正在加载 run…</p>
      ) : run.isError ? (
        <p role="alert" className="text-sm text-destructive">
          加载 run 失败：{run.error.message}
        </p>
      ) : (
        <RunView run={run.data} />
      )}
    </div>
  );
}
