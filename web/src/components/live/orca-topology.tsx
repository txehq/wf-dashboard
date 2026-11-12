import { useQuery } from '@tanstack/react-query';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { EngineLogo } from '@/components/live/live-identity';
import { HostLabel } from '@/components/ssh/ssh-parts';
import { Badge } from '@/components/ui/badge';
import { formatDateTime } from '@/lib/format';
import {
  type LiveSummary,
  type OrcaRunView,
  orcaSyncOnOpenQuery,
  orcaTopologyQuery,
} from '@/lib/live-api';
import { cn } from '@/lib/utils';

// Topology drawer (Contracts 35.4): each Run as a compact tree, its main agent on top and its workers in collapsible
// groups by state, one row per worker with its state, title, engine and start time; clicking a row opens that
// item's tab. Below the tree, the Run's messages, with unanswered questions marked

type OrcaState = OrcaRunView['coordinator']['state'];
type Worker = OrcaRunView['workers'][number];

const stateLabel: Record<OrcaState, string> = {
  working: 'Working',
  idle: 'Idle',
  waiting: 'Waiting for answer',
  succeeded: 'Succeeded',
  failed: 'Failed',
  exited: 'Exited',
};

// The groups a Run's workers fall into, in the order they are shown
const groups = [
  { key: 'working', label: 'Working', states: ['working'] },
  { key: 'waiting', label: 'Waiting', states: ['waiting', 'idle'] },
  { key: 'exited', label: 'Exited', states: ['succeeded', 'failed', 'exited'] },
] as const satisfies readonly { key: string; label: string; states: readonly OrcaState[] }[];
type GroupKey = (typeof groups)[number]['key'];

// A Run with more workers than this opens with its exited group collapsed
const MANY_WORKERS = 20;

const stateTone: Record<OrcaState, string> = {
  working: 'bg-[var(--viz-status-good)]',
  idle: 'bg-muted-foreground/50',
  waiting: 'bg-amber-500',
  succeeded: 'bg-[var(--viz-status-good)]/60',
  failed: 'bg-[var(--viz-status-serious)]',
  exited: 'bg-muted-foreground/30',
};

function StateBadge({ state }: { state: OrcaState }) {
  return (
    <Badge variant="outline" className="shrink-0 gap-1 font-normal" data-state={state}>
      <span className={cn('size-1.5 rounded-full', stateTone[state])} aria-hidden />
      {stateLabel[state]}
    </Badge>
  );
}

const engineOf = (agent: string | null) => (agent === 'claude' || agent === 'codex' ? agent : null);

export function OrcaTopologyPanel({
  live,
  onOpen,
}: {
  live: LiveSummary;
  onOpen: (liveId: string) => void;
}) {
  // The latest topology the server holds shows at once; the sync started on opening brings the rest through
  // orca.updated. A sync can take tens of seconds on a busy machine with large Runs
  const topology = useQuery(orcaTopologyQuery);
  const synced = useQuery(orcaSyncOnOpenQuery);
  if (topology.data === undefined) {
    return topology.isError ? (
      <p role="alert" className="text-sm text-destructive">
        {topology.error.message}
      </p>
    ) : (
      <p className="text-sm text-muted-foreground">Loading Orca…</p>
    );
  }
  const { local, runs } = topology.data;
  if (!local.running) {
    // Before the server's first read there is nothing to show yet; the sync started on opening is that read
    if (synced.isPending) return <p className="text-sm text-muted-foreground">Reading Orca…</p>;
    return (
      <p className="text-sm text-muted-foreground" data-testid="orca-not-running">
        Orca isn't running: {local.reason}
      </p>
    );
  }
  // Runs this item belongs to: as their main agent, or as one of their workers
  const own = runs.filter(
    (run) =>
      run.coordinator.liveId === live.id ||
      run.workers.some((w) => w.liveId === live.id) ||
      run.id === live.orca.runId,
  );
  if (own.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="orca-no-run">
        This item isn't part of an Orca collaboration.
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-5" data-testid="orca-topology">
      {own.map((run) => (
        <RunTree key={run.id} run={run} live={live} onOpen={onOpen} />
      ))}
    </div>
  );
}

function RunTree({
  run,
  live,
  onOpen,
}: {
  run: OrcaRunView;
  live: LiveSummary;
  onOpen: (liveId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<GroupKey>>(
    () => new Set(run.workers.length > MANY_WORKERS ? ['exited'] : []),
  );
  const working = run.workers.filter((w) => w.state === 'working').length;
  return (
    <section className="flex min-w-0 flex-col gap-2" data-testid="orca-run" data-run={run.id}>
      <h3 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
        <span className="min-w-0 truncate" title={run.objective}>
          {run.objective}
        </span>
        {run.host !== null && <HostLabel label={run.host.label} className="shrink-0" />}
        <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground">
          {run.workers.length} {run.workers.length === 1 ? 'worker' : 'workers'} · {working} working
        </span>
      </h3>
      <ul className="flex min-w-0 flex-col" aria-label="Collaborating items" role="tree">
        <li role="treeitem" aria-selected={run.coordinator.liveId === live.id}>
          <NodeRow
            title={`Main agent · ${run.objective}`}
            state={run.coordinator.state}
            agent={run.coordinator.agent}
            at={run.createdAt}
            liveId={run.coordinator.liveId}
            active={run.coordinator.liveId === live.id}
            onOpen={onOpen}
          />
          <ul className="ml-3 flex min-w-0 flex-col border-l pl-2" role="group">
            {groups.map((group) => {
              const members = run.workers.filter((w) =>
                (group.states as readonly OrcaState[]).includes(w.state),
              );
              if (members.length === 0) return null;
              const open = !collapsed.has(group.key);
              return (
                <li key={group.key} role="treeitem" aria-expanded={open} aria-selected={false}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-1 rounded px-1 py-0.5 text-xs font-medium text-muted-foreground hover:bg-muted/50"
                    data-testid="orca-group"
                    data-group={group.key}
                    aria-expanded={open}
                    onClick={() => {
                      const next = new Set(collapsed);
                      if (open) next.add(group.key);
                      else next.delete(group.key);
                      setCollapsed(next);
                    }}
                  >
                    <ChevronRight
                      className={cn('size-3.5 transition-transform', open && 'rotate-90')}
                      aria-hidden
                    />
                    {group.label}
                    <span className="font-normal">({members.length})</span>
                  </button>
                  {open && (
                    <ul className="flex min-w-0 flex-col" role="group">
                      {members.map((worker) => (
                        <li
                          key={worker.dispatchId}
                          role="treeitem"
                          aria-selected={worker.liveId === live.id}
                        >
                          <WorkerRow worker={worker} live={live} onOpen={onOpen} />
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </li>
      </ul>
      <Messages run={run} />
    </section>
  );
}

function WorkerRow({
  worker,
  live,
  onOpen,
}: {
  worker: Worker;
  live: LiveSummary;
  onOpen: (liveId: string) => void;
}) {
  const last = worker.lastMessage;
  return (
    <NodeRow
      title={worker.title}
      hint={last === null ? undefined : `${last.type}: ${last.subject}`}
      state={worker.state}
      agent={worker.agent}
      at={worker.startedAt}
      liveId={worker.liveId}
      active={worker.liveId === live.id}
      onOpen={onOpen}
    />
  );
}

// One row of the tree; a row whose agent has no Live item yet is shown but cannot be opened
function NodeRow({
  title,
  hint,
  state,
  agent,
  at,
  liveId,
  active,
  onOpen,
}: {
  title: string;
  hint?: string | undefined;
  state: OrcaState;
  agent: string | null;
  at: number | null;
  liveId: string | null;
  active: boolean;
  onOpen: (liveId: string) => void;
}) {
  const engine = engineOf(agent);
  const content = (
    <>
      <StateBadge state={state} />
      <span
        className="min-w-0 flex-1 truncate"
        title={hint === undefined ? title : `${title}\n${hint}`}
      >
        {title}
      </span>
      {engine === null ? (
        <span className="size-3.5 shrink-0" aria-hidden />
      ) : (
        <EngineLogo engine={engine} className="size-3.5" />
      )}
      <span className="w-[6.5rem] shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        {at === null ? '—' : formatDateTime(new Date(at).toISOString())}
      </span>
    </>
  );
  const row = 'flex w-full min-w-0 items-center gap-2 rounded px-1.5 py-1 text-left text-sm';
  if (liveId === null) {
    return (
      <span
        className={cn(row, 'text-muted-foreground')}
        title="No Live item yet"
        data-testid="orca-node"
      >
        {content}
      </span>
    );
  }
  return (
    <button
      type="button"
      aria-current={active}
      data-testid="orca-node"
      data-orca-live={liveId}
      className={cn(
        row,
        'cursor-pointer hover:bg-muted/60 aria-[current=true]:bg-muted aria-[current=true]:font-medium',
      )}
      onClick={() => {
        onOpen(liveId);
      }}
    >
      {content}
    </button>
  );
}

function Messages({ run }: { run: OrcaRunView }) {
  return (
    <details className="group flex flex-col gap-1" open={run.messages.length <= MANY_WORKERS}>
      <summary className="flex cursor-pointer items-center gap-1 text-sm font-medium">
        <ChevronRight className="size-3.5 transition-transform group-open:rotate-90" aria-hidden />
        {run.messages.length} {run.messages.length === 1 ? 'message' : 'messages'}
        {run.messages.some((m) => m.answered === false) && (
          <Badge variant="outline" className="ml-1">
            Unanswered question
          </Badge>
        )}
      </summary>
      <ul className="mt-1 flex flex-col gap-1" data-testid="orca-messages">
        {run.messages.map((message) => (
          <li key={message.id} className="flex min-w-0 flex-col rounded border px-2 py-1">
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="shrink-0 font-mono">{message.type}</span>
              {message.answered === false && (
                <Badge variant="outline" data-testid="orca-unanswered">
                  Unanswered
                </Badge>
              )}
              <span className="shrink-0">{formatDateTime(new Date(message.at).toISOString())}</span>
            </span>
            <span className="truncate text-sm" title={message.subject}>
              {message.subject}
            </span>
            {message.body !== '' && (
              <span className="line-clamp-3 text-xs text-muted-foreground">{message.body}</span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}
