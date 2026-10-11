import type { ReactNode } from 'react';
import { RequestTimeline } from '@/components/sessions/request-timeline';
import { ToolBars } from '@/components/sessions/session-summary';
import { StatusLabel } from '@/components/sessions/status-label';
import { formatCount, formatDuration, formatInteger, formatUsd } from '@/lib/format';
import type { StageView, SubagentInfo, Workflow, WorkflowCycle } from '@/lib/sessions-api';
import { cycleName, methodLabel } from '@/lib/stage-status';

function field(evidence: unknown, key: string): string | number | null {
  if (typeof evidence !== 'object' || evidence === null) return null;
  const value = (evidence as Record<string, unknown>)[key];
  return typeof value === 'string' || typeof value === 'number' ? value : null;
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 font-mono break-all">{children}</dd>
    </>
  );
}

// lfg 证据：写出产物的 wf obsidian 调用；ic 证据：判定进入该阶段的那一条行为
function Evidence({ workflow, view }: { workflow: Workflow; view: StageView }) {
  const e = view.evidence;
  const note = field(e, 'note');
  const seq = field(e, 'seq');
  const toolCallId = field(e, 'toolCallId');
  if (workflow === 'lfg') {
    const path = field(e, 'path');
    if (path === null)
      return (
        <p className="text-sm text-muted-foreground">
          {note ??
            (view.status === 'active' || view.status === 'interrupted'
              ? '还没有写出这个阶段的产物。'
              : '没有判定证据。')}
        </p>
      );
    const lock = field(e, 'planLockLine');
    return (
      <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-xs">
        <Row label="产物">{path}</Row>
        {lock !== null && <Row label="锁定标记">{lock}</Row>}
        <Row label="触发调用">
          #{seq} · {toolCallId}
        </Row>
        <Row label="命令">
          <span className="whitespace-pre-wrap">{field(e, 'command')}</span>
        </Row>
      </dl>
    );
  }
  const summary = field(e, 'summary');
  if (summary === null)
    return (
      <p className="text-sm text-muted-foreground">
        {view.status === 'skipped'
          ? '这一轮从后面的阶段开始，这个阶段被跳过。'
          : view.status === 'not-reached'
            ? '这一轮没有进入这个阶段。'
            : '没有判定证据。'}
      </p>
    );
  const label =
    view.method === 'skill'
      ? view.status === 'skipped'
        ? '越过它的 Skill 调用'
        : 'Skill 调用'
      : view.status === 'skipped'
        ? '跳过时的行为'
        : '进入行为';
  return (
    <dl className="grid grid-cols-[6rem_1fr] gap-x-3 gap-y-1 text-xs" data-testid="stage-evidence">
      <Row label={label}>
        <span className="whitespace-pre-wrap">{summary}</span>
      </Row>
      <Row label="所在请求">
        #{seq} · {toolCallId}
      </Row>
    </dl>
  );
}

function rangeText(view: StageView): string {
  if (view.startSeq === null || view.endSeq === null) return '没有请求区间';
  if (view.endSeq < view.startSeq) return `区间为空（下一阶段从 #${String(view.startSeq)} 开始）`;
  return `主 session 请求 #${String(view.startSeq)} – #${String(view.endSeq)}`;
}

export function StageDetail({
  sessionId,
  workflow,
  cycle,
  view,
  subagents,
}: {
  sessionId: string;
  workflow: Workflow;
  cycle: WorkflowCycle | undefined;
  view: StageView;
  subagents: SubagentInfo[];
}) {
  const s = view.stats;
  const hasRange = view.startSeq !== null && view.endSeq !== null && view.endSeq >= view.startSeq;
  return (
    <section
      aria-label={`${view.stage} 阶段详情`}
      className="flex flex-col gap-4"
      data-testid="stage-detail"
    >
      <header className="flex flex-wrap items-baseline gap-3">
        <h2 className="font-mono text-lg font-semibold">
          /{workflow} · {view.stage}
        </h2>
        <StatusLabel status={view.status} />
        {view.status === 'interrupted' && cycle?.endSeq !== null && cycle !== undefined && (
          <span className="text-xs" data-testid="stage-interrupted">
            后来开始了另一轮流程，这一轮在请求 #{cycle.endSeq} 结束
          </span>
        )}
        {cycle !== undefined && (
          <span className="rounded border px-1.5 py-0.5 text-xs" data-testid="stage-cycle">
            {cycleName(cycle)}
          </span>
        )}
        <span className="text-xs text-muted-foreground">
          <span data-testid="stage-method">{methodLabel[view.method]}</span> · {rangeText(view)}
        </span>
      </header>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-lg border px-4 py-3">
          <h3 className="text-sm font-medium">判定证据</h3>
          <Evidence workflow={workflow} view={view} />
        </div>
        <div className="flex flex-col gap-2 rounded-lg border px-4 py-3">
          <h3 className="text-sm font-medium">阶段统计</h3>
          <dl className="grid grid-cols-[auto_1fr_auto_1fr] gap-x-3 gap-y-1 text-xs tabular-nums">
            <dt className="text-muted-foreground">请求</dt>
            <dd>
              {formatInteger(s.requests)}（含 {s.subagents} 个子代理）
            </dd>
            <dt className="text-muted-foreground">花费</dt>
            <dd>{formatUsd(s.costUsd)}</dd>
            <dt className="text-muted-foreground">input</dt>
            <dd>{formatCount(s.inputTokens)}</dd>
            <dt className="text-muted-foreground">output</dt>
            <dd>{formatCount(s.outputTokens)}</dd>
            <dt className="text-muted-foreground">cache 读</dt>
            <dd>{formatCount(s.cacheReadTokens)}</dd>
            <dt className="text-muted-foreground">cache 写</dt>
            <dd>{formatCount(s.cacheCreationTokens)}</dd>
            <dt className="text-muted-foreground">耗时</dt>
            <dd>{formatDuration(s.durationMs)}</dd>
          </dl>
          {Object.keys(s.toolCalls).length > 0 && (
            <ToolBars counts={s.toolCalls} label={`${view.stage} 阶段各 tool 的调用次数`} />
          )}
        </div>
      </div>
      {hasRange ? (
        <RequestTimeline
          key={`${workflow}:${view.stage}`}
          sessionId={sessionId}
          range={{ fromSeq: view.startSeq ?? 0, toSeq: view.endSeq ?? 0 }}
          subagents={subagents}
        />
      ) : (
        <p className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
          {view.status === 'skipped'
            ? '这个阶段被跳过，没有请求。'
            : view.status === 'active'
              ? '已进入这个阶段，但之后还没有请求。'
              : view.status === 'interrupted'
                ? '这一轮在进入这个阶段时被中断：后来开始了另一轮流程。'
                : '没有进入这个阶段。'}
        </p>
      )}
    </section>
  );
}
