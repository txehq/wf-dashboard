import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Bot,
  ChevronDown,
  ChevronRight,
  ChevronsLeftRight,
  Hand,
  Network,
  PanelLeftClose,
  Plus,
  Power,
  RotateCcw,
  Server,
  Undo2,
  X,
} from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { type DraftControls, useDraftControls } from '@/components/live/draft-controls';
import { FullscreenArea, FullscreenButton, useFullscreen } from '@/components/fullscreen';
import { FinderMenu } from '@/components/live/finder-menu';
import { OpenInVscode } from '@/components/live/open-in-vscode';
import { LOCAL_SERVER_ID } from '@/lib/vscode-api';
import { RemoteCopyMenu } from '@/components/live/remote-copy-menu';
import { HostLabel } from '@/components/ssh/ssh-parts';
import { ImportSessionsButton } from '@/components/live/import-sessions';
import { HideButton, ItemMenu, UnhideButton } from '@/components/live/item-actions';
import {
  EngineLogo,
  PurposeBadge,
  PurposeBand,
  PurposeFilterBar,
} from '@/components/live/live-identity';
import { purposeLabel, usePurposeFilter } from '@/lib/live-purpose';
import { type Branch, treeRows } from '@/lib/live-tree';
import { LiveTerminal } from '@/components/live/live-terminal';
import { LiveTitle } from '@/components/live/live-title';
import { BranchStatus, DeployStatus, WorktreePreparation } from '@/components/live/magi-parts';
import { NewLiveForm } from '@/components/live/new-live-form';
import { OrcaTopologyPanel } from '@/components/live/orca-topology';
import { WorkerConversation } from '@/components/live/worker-conversation';
import { ResumeButton } from '@/components/live/resume-dialog';
import { GoalButton, GoalDialog } from '@/components/live/simulated-goal';
import { DRAWER_WIDTH, SideDrawer } from '@/components/live/side-drawer';
import { CompactLiveList } from '@/components/live/compact-list';
import { DesignWork } from '@/components/live/workflow-panel';
import { SessionConversation } from '@/components/runs/conversation';
import { RequestTimeline } from '@/components/sessions/request-timeline';
import { StageBars } from '@/components/sessions/stage-bars';
import { UNPRICED } from '@/components/sessions/session-table';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDateTime, formatNoun, formatUsd } from '@/lib/format';
import { resumeMagi, useMagiWorktree } from '@/lib/magi-api';
import { MagiRobot } from '@/components/magi-robot';
import {
  type LiveDetail,
  type LiveDriver,
  type LiveSummary,
  liveListQuery,
  liveQuery,
  setLiveDriver,
  stopLive,
  useLiveSessionEvents,
} from '@/lib/live-api';
import { sessionQuery, stagesQuery, useSessionEvents } from '@/lib/sessions-api';
import { cycleName } from '@/lib/stage-status';
import { cn } from '@/lib/utils';
import { allVariantsQuery } from '@/pages/variants-api';

const environmentLabel = { isolated: 'isolated', real: 'real' } as const;
const driverLabel = { human: 'Human', simulated: 'Simulated user' } as const;
const engineName = { claude: 'Claude Code', codex: 'Codex' } as const;

// Shortcuts to switch interaction items in full screen (Contracts 20.3): ⌃⇧[ previous, ⌃⇧] next
// (Control on macOS, not Command). Like ⌃⇧F for full screen, caught in the window capture phase so the
// terminal never gets them. A terminal can't send this combination anyway (Control+[ is Esc, with
// Shift too), Claude Code and Codex never use it, and Chrome on macOS has no Control+Shift+[ or ]
const SWITCH_SHORTCUT_LABEL = '⌃⇧[ / ⌃⇧]';
function switchDirection(event: KeyboardEvent): -1 | 1 | null {
  if (!event.ctrlKey || !event.shiftKey || event.metaKey || event.altKey) return null;
  if (event.code === 'BracketLeft') return -1;
  if (event.code === 'BracketRight') return 1;
  return null;
}

// Config used by the latest run; items never run (imported locally) have none. On an SSH host with no
// variant chosen it is the remote machine's config
const variantLabel = (live: LiveSummary) =>
  live.process === null
    ? '—'
    : (live.variantName ??
      (live.host === null ? 'Local config' : `${live.host.label ?? 'Deleted host'} config`));

// Config and environment on a list item's second line: for Magi Agent items its config (the
// environment is always real, so omitted); items on an SSH host always use the remote real directory,
// and the host is shown separately
const metaLabel = (live: LiveSummary) =>
  live.purpose === 'agent'
    ? (live.agentConfigName ?? '')
    : live.host !== null
      ? variantLabel(live)
      : `${variantLabel(live)} · ${environmentLabel[live.environment]}`;

// Who ended an exited item (stop event, Contracts 14.3): shown on hovering the status; absent when the
// process exited by itself or ended automatically
const stopSourceLabel = { page: 'Stopped from the page', api: 'Stopped via the API' } as const;
function stoppedBy(live: LiveDetail): string | undefined {
  const stop = live.events.findLast(
    (e) => e.kind === 'stop' && e.processId !== null && e.processId === live.process?.id,
  );
  if (stop === undefined) return undefined;
  const source = stop.payload.source as keyof typeof stopSourceLabel;
  return `${stopSourceLabel[source]} (${formatDateTime(new Date(stop.at).toISOString())})`;
}

// Orca-hosted items (Contracts 35.4): status is the one Orca reports
const orcaStateLabel = {
  working: 'Working',
  idle: 'Idle',
  waiting: 'Waiting for answer',
  succeeded: 'Succeeded',
  failed: 'Failed',
  exited: 'Exited',
} as const;

function StatusBadge({ live }: { live: LiveSummary | LiveDetail }) {
  // A running Orca-hosted item shows the status Orca reports
  if (live.orca.hosted && live.status === 'running' && live.orca.state !== null) {
    return (
      <Badge
        data-testid="live-status"
        data-status="running"
        data-orca-state={live.orca.state}
        variant={live.orca.state === 'working' ? 'default' : 'secondary'}
      >
        {orcaStateLabel[live.orca.state]}
      </Badge>
    );
  }
  if (live.status === 'running') {
    return (
      <Badge data-testid="live-status" data-status="running">
        Running
      </Badge>
    );
  }
  if (live.status === 'idle') {
    return (
      <Badge variant="secondary" data-testid="live-status" data-status="idle">
        Not running
      </Badge>
    );
  }
  const code = live.process?.exitCode ?? null;
  return (
    <Badge
      variant="outline"
      data-testid="live-status"
      data-status="exited"
      title={'events' in live ? stoppedBy(live) : undefined}
    >
      Exited{code === null ? '' : ` (${String(code)})`}
    </Badge>
  );
}

// Left list: items with a running process first, the rest by most recent update; each shows name,
// status, variant, environment and resume count. Each can be closed with "×" (hidden only) or deleted
// from its menu; the switch at the bottom lists closed items (Contracts 14.5)
function LiveList({
  onOpen,
  onGone,
  active,
  onCollapse,
}: {
  onOpen: (id: string) => void;
  // After closing or deleting: close its tab
  onGone: (id: string) => void;
  active: string | null;
  // The user can collapse the list to a strip to give the terminal the width (Contracts 26.1)
  onCollapse: () => void;
}) {
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = usePurposeFilter();
  // Main agents whose workers are collapsed
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const list = useQuery(liveListQuery(showHidden));
  const all = list.data ?? [];
  // Magi Agent items are ordered like the others, the fifth purpose filter (Contracts 23.6)
  const shown = filter === 'all' ? all : all.filter((l) => l.purpose === filter);
  const counts = {
    all: all.length,
    interaction: all.filter((l) => l.purpose === 'interaction').length,
    design: all.filter((l) => l.purpose === 'design').length,
    optimize: all.filter((l) => l.purpose === 'optimize').length,
    agent: all.filter((l) => l.purpose === 'agent').length,
    orca: all.filter((l) => l.purpose === 'orca').length,
  };
  // The list as a tree (Contracts 35.4): workers indented under the main agent that dispatched them,
  // deeper levels indent further; when the main agent is not shown (e.g. filtered out), the worker is its own row
  const rows = treeRows(shown, collapsed, (id) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  });
  const item = (live: LiveSummary, branch: Branch | null) => {
    const hidden = live.hiddenAt !== null;
    return (
      <li key={live.id} style={branch === null ? undefined : { marginLeft: branch.depth * 12 }}>
        <div
          role="button"
          tabIndex={0}
          data-live={live.id}
          data-hidden={hidden}
          data-purpose={live.purpose}
          data-depth={branch?.depth ?? 0}
          aria-current={active === live.id}
          className="magi-robot-host flex w-full cursor-pointer gap-2 rounded-md border py-2 pr-3 pl-1.5 text-left hover:bg-muted/50 aria-[current=true]:border-foreground data-[hidden=true]:border-dashed data-[hidden=true]:opacity-70"
          onClick={() => {
            onOpen(live.id);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onOpen(live.id);
          }}
        >
          <PurposeBand purpose={live.purpose} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            {/* Name on one line, truncated with the full text on hover; Magi Agent items show their
                purpose by color band and little robot, without a purpose tag */}
            <span className="flex items-center gap-1">
              {/* Items that dispatched workers: collapse and expand their workers (Contracts 35.4) */}
              {branch !== null && branch.workers > 0 && (
                <button
                  type="button"
                  className="shrink-0 rounded text-muted-foreground hover:bg-muted hover:text-foreground"
                  aria-label={branch.collapsed ? 'Expand workers' : 'Collapse workers'}
                  aria-expanded={!branch.collapsed}
                  data-testid="live-tree-toggle"
                  onClick={(event) => {
                    event.stopPropagation();
                    branch.onToggle();
                  }}
                >
                  {branch.collapsed ? (
                    <ChevronRight className="size-4" />
                  ) : (
                    <ChevronDown className="size-4" />
                  )}
                </button>
              )}
              {live.purpose === 'agent' && <MagiRobot className="size-4" label="Magi Agent" />}
              <EngineLogo engine={live.engine} className="size-4" />
              <span className="min-w-0 flex-1">
                <LiveTitle
                  liveId={live.id}
                  title={live.title}
                  className="min-w-0 truncate text-sm font-medium"
                />
              </span>
              <ItemMenu
                live={live}
                onDeleted={() => {
                  onGone(live.id);
                }}
              />
              {!hidden && (
                <HideButton
                  live={live}
                  onHidden={() => {
                    onGone(live.id);
                  }}
                />
              )}
            </span>
            {/* Purpose, status and config on one line; config etc. truncate with the full text on hover */}
            <span className="flex min-w-0 items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
              {live.purpose !== 'agent' && <PurposeBadge live={live} />}
              <StatusBadge live={live} />
              {live.host !== null && (
                <HostLabel label={live.host.label} className="max-w-28 shrink-0" />
              )}
              <span className="min-w-0 truncate" title={metaLabel(live)}>
                {metaLabel(live)} ·{' '}
                <span data-testid="live-resume-count">
                  {live.resumeCount === 1
                    ? 'resumed once'
                    : `resumed ${String(live.resumeCount)} times`}
                </span>
              </span>
            </span>
            {/* When collapsed, show how many workers there are and how many are working (Contracts 35.4) */}
            {branch !== null && branch.collapsed && branch.workers > 0 && (
              <span className="text-xs text-muted-foreground" data-testid="live-tree-summary">
                {formatNoun(branch.workers, 'worker')}, {branch.working} working
              </span>
            )}
            <span className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              {formatDateTime(new Date(live.updatedAt).toISOString())}
              {hidden && <UnhideButton live={live} />}
            </span>
          </span>
        </div>
      </li>
    );
  };
  let body;
  if (list.isPending) body = <p className="text-sm text-muted-foreground">Loading…</p>;
  else if (list.isError) {
    body = (
      <p role="alert" className="text-sm text-destructive">
        {list.error.message}
      </p>
    );
  } else if (list.data.length === 0) {
    body = <p className="text-sm text-muted-foreground">No Live sessions yet.</p>;
  } else if (shown.length === 0) {
    body = <p className="text-sm text-muted-foreground">No items with this purpose.</p>;
  } else {
    body = (
      <ul className="flex flex-col gap-1" aria-label="Live sessions" data-testid="live-list">
        {rows.map(({ live, branch }) => item(live, branch))}
      </ul>
    );
  }
  return (
    <>
      {/* Row above the list: purpose filter and "Show closed items" */}
      <div className="flex items-center gap-2">
        <PurposeFilterBar value={filter} onChange={setFilter} counts={counts} />
        <label
          className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground"
          title="Show closed items"
        >
          <input
            type="checkbox"
            data-testid="show-hidden"
            checked={showHidden}
            onChange={(event) => {
              setShowHidden(event.target.checked);
            }}
          />
          Closed
        </label>
        <button
          type="button"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Collapse list"
          title="Collapse list"
          data-testid="live-list-collapse"
          onClick={onCollapse}
        >
          <PanelLeftClose className="size-4" />
        </button>
      </div>
      {body}
    </>
  );
}

// Cost of design and optimize sessions (Contracts 28.4, subagents included); hidden until the session
// is imported, and "—" like the Sessions table when the model is not in the price list
function SessionCost({ sessionId }: { sessionId: string }) {
  const session = useQuery(sessionQuery(sessionId));
  if (session.data === undefined) return null;
  const { priced, costUsd } = session.data;
  return (
    <span
      className="text-sm text-muted-foreground tabular-nums"
      title={priced ? 'Cost of this session (subagents included)' : UNPRICED}
      data-testid="live-session-cost"
    >
      <span data-toolbar-label>Cost </span>
      {priced ? formatUsd(costUsd) : '—'}
    </span>
  );
}

// Stage bars and request details beside the terminal (reusing the Sessions detail components). Until
// the session writes its first record (design and optimize items have no session id before first
// start), says it isn't imported yet. The "no stage yet" note names, for interaction items, the
// workflows used for splitting, and for design and optimize items (designFlow not undefined) the
// draft's workflow; nothing while the draft is still loading
function SessionSide({
  sessionId,
  engine,
  designFlow,
}: {
  sessionId: string | null;
  engine: LiveSummary['engine'];
  designFlow: string | null | undefined;
}) {
  const notImported = (
    <p className="text-sm text-muted-foreground" data-testid="live-side-pending">
      Session not imported yet (appears after {engineName[engine]} writes its first record).
    </p>
  );
  if (sessionId === null) return notImported;
  return <ImportedSide sessionId={sessionId} notImported={notImported} designFlow={designFlow} />;
}

function ImportedSide({
  sessionId,
  notImported,
  designFlow,
}: {
  sessionId: string;
  notImported: ReactNode;
  designFlow: string | null | undefined;
}) {
  const session = useQuery(sessionQuery(sessionId));
  const stages = useQuery(stagesQuery(sessionId));
  if (session.data === undefined || stages.data === undefined) {
    return session.isPending || stages.isPending ? (
      <p className="text-sm text-muted-foreground">Loading session…</p>
    ) : (
      notImported
    );
  }
  const workflows = stages.data.workflows.filter((w) => w.cycles.length > 0);
  let names: string | null;
  if (designFlow === undefined) {
    names = stages.data.workflows.map((w) => `/${w.workflow}`).join(' or ');
  } else names = designFlow === null ? null : `/${designFlow}`;
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="live-side">
      {workflows.length === 0 && names !== null && names !== '' && (
        <p className="text-sm text-muted-foreground" data-testid="live-side-no-stage">
          No {names} stage reached yet.
        </p>
      )}
      {workflows.flatMap(({ workflow, cycles }) =>
        cycles.map((cycle) => (
          <section key={`${workflow}-${String(cycle.index)}`} className="flex flex-col gap-2">
            <h3 className="text-sm font-semibold">
              /{workflow} · {cycleName(cycle)}
            </h3>
            <StageBars views={cycle.stages} />
          </section>
        )),
      )}
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold">Requests</h3>
        <RequestTimeline
          sessionId={sessionId}
          range={{}}
          subagents={session.data.subagents}
          follow
        />
      </section>
    </div>
  );
}

// Driver switch and "Hand back" (Contracts 34.2): available for every purpose, both engines, local and
// SSH host items. An item without a task records this time's goal first (prefilled with the first
// request) the first time it is handed to the simulated user
function DriverControls({
  data,
  onDriver,
  driverPending,
}: {
  data: LiveDetail;
  onDriver: (next: LiveDriver, goal?: string) => void;
  driverPending: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const running = data.status === 'running';
  const needGoal = data.taskId === null && data.simulatedGoal === null;
  const toSimulated = () => {
    if (needGoal) setAsking(true);
    else onDriver('simulated');
  };
  return (
    <>
      <div
        role="radiogroup"
        aria-label="Driver"
        className="flex rounded-md border p-0.5"
        data-testid="driver-switch"
        data-driver={data.driver}
      >
        {(['human', 'simulated'] as const).map((d) => (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={data.driver === d}
            data-driver={d}
            title={driverLabel[d]}
            disabled={!running || data.starting || driverPending || data.driver === d}
            className="flex items-center gap-1 rounded px-2.5 py-0.5 text-sm aria-checked:bg-foreground aria-checked:text-background disabled:cursor-not-allowed"
            onClick={() => {
              if (d === 'simulated') toSimulated();
              else onDriver('human');
            }}
          >
            {d === 'human' ? <Hand className="size-3.5" /> : <Bot className="size-3.5" />}
            <span data-driver-label>{driverLabel[d]}</span>
          </button>
        ))}
      </div>
      <Button
        size="sm"
        variant="outline"
        data-testid="hand-back"
        title="Hand back to the simulated user"
        disabled={!running || data.starting || data.driver === 'simulated' || driverPending}
        onClick={toSimulated}
      >
        <Undo2 />
        <span data-toolbar-label>Hand back</span>
      </Button>
      {data.taskId === null && <GoalButton live={data} />}
      {asking && (
        <GoalDialog
          heading="Goal for the simulated user"
          initial={data.simulatedGoal ?? data.simulatedGoalDefault}
          pending={driverPending}
          error={null}
          onSave={(goal) => {
            setAsking(false);
            onDriver('simulated', goal);
          }}
          onClose={() => {
            setAsking(false);
          }}
        />
      )}
    </>
  );
}

function Notices({ live }: { live: LiveDetail }) {
  const notice = 'rounded-md border px-3 py-1 text-sm';
  return (
    <>
      {live.starting && (
        <p role="status" className={notice} data-testid="live-starting">
          Starting. Answer any confirmations in the terminal.
        </p>
      )}
      {/* On an SSH host the process keeps running in tmux when the connection drops (Contracts 31.4) */}
      {live.connected === false && (
        <p
          role="status"
          className={cn(notice, 'border-warning-border bg-warning text-warning-foreground')}
          data-testid="live-disconnected"
        >
          Lost connection to {live.host?.label ?? 'the remote'}. The remote process keeps running in
          tmux while reconnecting; the simulated user doesn't drive while disconnected.
        </p>
      )}
      {live.handedBack === 'disconnected' && live.connected !== false && (
        <p role="status" className={notice}>
          The connection dropped, so the driver switched to you. Hand back to the simulated user
          when needed.
        </p>
      )}
      {live.handedBack === 'done' && (
        <p role="status" className={notice} data-testid="live-done">
          {live.doneReason === null
            ? 'The simulated user considers it finished.'
            : `The simulated user considers it done: ${live.doneReason}`}
        </p>
      )}
      {live.handedBack === 'max-turns' && (
        <p role="status" className={notice}>
          The simulated user reached its answer limit and handed control to you.
        </p>
      )}
      {live.error !== null && (
        <p role="alert" className={cn(notice, 'border-destructive text-destructive')}>
          {live.error}
        </p>
      )}
      {/* Remote session sync failure (Contracts 31.6): disappears on the next successful sync */}
      {live.syncFailure !== null && (
        <p
          role="alert"
          className={cn(notice, 'border-destructive text-destructive')}
          data-testid="live-sync-failure"
        >
          Last sync failed ({formatDateTime(new Date(live.syncFailure.at).toISOString())}):{' '}
          {live.syncFailure.message}
        </p>
      )}
      {/* The Orca pane is gone while the process is still running (Contracts 35.3) */}
      {live.orca.paneGone !== null && (
        <p role="status" className={notice} data-testid="live-pane-gone">
          {live.orca.paneGone}
        </p>
      )}
    </>
  );
}

// The terminal (or the conversation of an item never run) and the right drawer share a row that fills
// the space below the toolbar (the rest of the page height outside full screen)
function WorkRow({ fullscreen, children }: { fullscreen: boolean; children: ReactNode }) {
  return (
    <div
      className={cn('flex min-w-0 flex-1 gap-3', fullscreen ? 'min-h-0' : 'min-h-[16rem]')}
      data-testid="live-work"
    >
      {children}
    </div>
  );
}

function LivePanel({
  liveId,
  onResumed,
  onOpen,
  fullscreen,
  extra,
}: {
  liveId: string;
  // resume lands on the same item (Contracts 14.5): the workspace selects its tab
  onResumed: (live: LiveDetail) => void;
  // Open another item's tab (clicking a node in the topology, Contracts 35.4)
  onOpen: (liveId: string) => void;
  fullscreen: boolean;
  // Far right of the toolbar: the full-screen item switcher and the full-screen button
  extra: ReactNode;
}) {
  const live = useQuery(liveQuery(liveId));
  const driver = useMutation({
    mutationFn: ({ next, goal }: { next: LiveDriver; goal?: string }) =>
      setLiveDriver(liveId, next, goal),
  });
  const stopping = useMutation({ mutationFn: () => stopLive(liveId) });
  if (live.data === undefined) {
    return live.isError ? (
      <p role="alert" className="text-sm text-destructive">
        {live.error.message}
      </p>
    ) : (
      <p className="text-sm text-muted-foreground">Loading…</p>
    );
  }
  const data = live.data;
  const stopButton = (
    <Button
      size="sm"
      variant="outline"
      disabled={stopping.isPending}
      title="Stop process"
      onClick={() => {
        stopping.mutate();
      }}
    >
      <Power />
      <span data-toolbar-label>Stop process</span>
    </Button>
  );
  const errors = (driver.isError || stopping.isError) && (
    <p role="alert" className="text-sm text-destructive">
      {(driver.error ?? stopping.error)?.message}
    </p>
  );
  const common = {
    data,
    stopButton,
    errors,
    fullscreen,
    extra,
    onResumed,
    onOpen,
    onDriver: (next: LiveDriver, goal?: string) => {
      driver.mutate({ next, ...(goal === undefined ? {} : { goal }) });
    },
    driverPending: driver.isPending,
  };
  if (data.purpose === 'agent') return <AgentPanel {...common} />;
  if (data.purpose === 'design' || data.purpose === 'optimize') return <DesignPanel {...common} />;
  return <ItemPanel {...common} draft={null} />;
}

interface PanelProps {
  data: LiveDetail;
  stopButton: ReactNode;
  errors: ReactNode;
  fullscreen: boolean;
  extra: ReactNode;
  onResumed: (live: LiveDetail) => void;
  onOpen: (liveId: string) => void;
  onDriver: (next: LiveDriver, goal?: string) => void;
  driverPending: boolean;
}

// The item takes part in an Orca collaboration (Contracts 35.4): it dispatched workers, or it is a worker in some Run
function useInOrcaRun(data: LiveSummary): boolean {
  const list = useQuery(liveListQuery(false));
  return data.orca.runId !== null || (list.data ?? []).some((l) => l.orca.parentLiveId === data.id);
}

// The toolbar's "Topology" button (Contracts 35.4): opens a drawer the same way as "Stages and requests"
function TopologyButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <Button
      size="sm"
      variant={open ? 'secondary' : 'ghost'}
      aria-pressed={open}
      data-testid="toggle-topology"
      title="Topology"
      onClick={onToggle}
    >
      <Network />
      <span data-toolbar-label>Topology</span>
    </Button>
  );
}

// Orca notes (Contracts 35.2, 35.4): hosted items say the terminal is Orca's rendered screen; items
// started by the dashboard without an Orca identity say why
const ORCA_HOSTED_NOTE =
  'Hosted by Orca: the terminal shows the screen Orca renders, refreshed every second, without colors or scrollback; input is sent to it as is.';
const ORCA_STRUCTURED_NOTE =
  'Orca runs this worker without a terminal: its transcript is read from Orca every 2 seconds, and a message you send reaches it as a message to its Dispatch.';
function OrcaNotice({ live }: { live: LiveSummary }) {
  if (live.orca.structured) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="live-orca-structured">
        {ORCA_STRUCTURED_NOTE}
      </p>
    );
  }
  if (live.orca.hosted) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="live-orca-hosted">
        {ORCA_HOSTED_NOTE}
      </p>
    );
  }
  if (live.status === 'running' && live.orca.identityReason !== null) {
    return (
      <p className="text-xs text-muted-foreground" data-testid="live-orca-identity">
        No Orca identity, so the agent can't dispatch workers with Orca: {live.orca.identityReason}
      </p>
    );
  }
  return null;
}

// Sessions designing a workflow or variant, and analysis optimize sessions (Contracts 17.3, 22, 26.1):
// the same panel as interaction items, plus draft save, cost and the workflow panel
function DesignPanel(props: PanelProps) {
  const draft = useDraftControls(props.data, props.onResumed);
  return <ItemPanel {...props} draft={draft} />;
}

// Name of the design's base variant (Contracts 26.1): blank designs have no base; a deleted base is
// marked (Contracts 24.3)
function BaseVariantName({ draft }: { draft: DraftControls['draft'] }) {
  const variants = useQuery(allVariantsQuery);
  if (draft === undefined) return <>—</>;
  const id = draft.baseVariantId;
  if (id === null) return <>Blank</>;
  const found = variants.data?.find((v) => v.id === id);
  if (found === undefined) return <>{id}</>;
  return <>{found.deletedAt === null ? found.name : `${found.name} (deleted)`}</>;
}

// Panel of an interaction item (Contracts 14.3, 20.3); design and optimize items (draft not null) use
// the same toolbar and line below, plus the draft parts and the workflow panel per 26.1
function ItemPanel({
  data,
  stopButton,
  errors,
  fullscreen,
  extra,
  onResumed,
  onOpen,
  onDriver,
  driverPending,
  draft,
}: PanelProps & { draft: DraftControls | null }) {
  // Right drawer: stages and requests, or the Orca topology (Contracts 35.4), one at a time
  const [drawer, setDrawer] = useState<'side' | 'topology' | null>(null);
  const side = drawer === 'side';
  const setSide = (open: boolean) => {
    setDrawer(open ? 'side' : null);
  };
  const inOrca = useInOrcaRun(data);
  const [drawerWidth, setDrawerWidth] = useState(DRAWER_WIDTH);
  const liveId = data.id;
  const running = data.status === 'running';
  const codex = data.engine === 'codex';
  // A worker Orca runs without a pane: no terminal and no driver, Orca's Dispatch carries its output and input
  const structured = data.orca.structured;
  // Interaction items have a session id from creation; design and optimize items have none before first start
  const sessionId = data.claudeSessionId;
  if (draft === null && sessionId === null)
    throw new Error(`Interaction ${liveId} has no session id`);
  const model = data.process?.model ?? null;
  const effort = data.process?.effort ?? null;
  let resume: ReactNode = null;
  if (draft !== null) resume = draft.resume;
  else if (data.process !== null && sessionId !== null) {
    resume = <ResumeButton sessionId={sessionId} onResumed={onResumed} />;
  }
  const finder =
    draft === null
      ? structured
        ? [{ label: 'Worktree', target: { kind: 'live-cwd', id: liveId } } as const]
        : [
            { label: 'Working directory', target: { kind: 'live-cwd', id: liveId } } as const,
            { label: 'Config directory', target: { kind: 'live-config', id: liveId } } as const,
          ]
      : [
          {
            label: data.purpose === 'optimize' ? 'Analysis directory' : 'Draft directory',
            target: { kind: 'live-cwd', id: liveId },
          } as const,
          {
            label: codex ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR',
            target: { kind: 'live-config', id: liveId },
          } as const,
        ];
  const workflow = draft === null ? data.workflow : (draft.draft?.workflowId ?? null);
  const closeSide = () => {
    setDrawer(null);
  };
  const drawerTitle = drawer === 'topology' ? 'Topology' : 'Stages and requests';
  const sideContent =
    drawer === 'topology' ? (
      <OrcaTopologyPanel live={data} onOpen={onOpen} />
    ) : (
      <SessionSide
        sessionId={sessionId}
        engine={data.engine}
        designFlow={draft === null ? undefined : workflow}
      />
    );
  let work: ReactNode;
  if (structured) {
    // A worker Orca runs without a pane (Contracts 35.4): its transcript and an input box in the terminal's place
    work = <WorkerConversation liveId={liveId} running={running} />;
  } else if (data.process !== null) {
    // resume starts a new process on the same item: rebuild the terminal per process, reconnect and replay the item's output
    work = <LiveTerminal key={data.process.id} liveId={liveId} />;
  } else if (draft !== null || sessionId === null) {
    // Design and optimize items start for the first time once the draft is prepared
    work = (
      <p className="flex flex-1 items-center justify-center rounded-md border border-dashed text-sm text-muted-foreground">
        {engineName[data.engine]} starts here once preparation finishes.
      </p>
    );
  } else {
    // Imported locally and never run (Contracts 14.5): show the session's conversation and the resume button
    work = (
      <div
        className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto rounded-md border p-4"
        data-testid="live-idle"
      >
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">
            This session hasn't run in the workspace yet. Resume it to continue the conversation
            here.
          </span>
          <ResumeButton sessionId={sessionId} onResumed={onResumed} />
        </div>
        <SessionConversation
          sessionId={sessionId}
          onJump={() => {
            setSide(true);
          }}
        />
      </div>
    );
  }
  return (
    <div
      className="@container flex min-h-0 min-w-0 flex-1 flex-col gap-2"
      data-testid="live-panel"
      data-live={liveId}
      data-purpose={data.purpose}
    >
      {/* Toolbar (Contracts 20.3, 26.1): all buttons on one row, kept in full screen. When the panel is
          too narrow for every label (72rem for interaction items, 81rem for design and optimize items,
          which add Save and Cost), the driver switch, Hand back, Goal, Stop process, resume, Stages and
          requests, Topology and Full screen show only icons with the name on hover, and cost shows only
          its number */}
      <div
        className={cn(
          'flex flex-wrap items-center gap-2',
          draft === null
            ? '@max-[72rem]:[&_[data-toolbar-label]]:sr-only @max-[72rem]:[&_[data-driver-label]]:sr-only'
            : '@max-[81rem]:[&_[data-toolbar-label]]:sr-only @max-[81rem]:[&_[data-driver-label]]:sr-only',
        )}
        data-testid="live-toolbar"
      >
        <StatusBadge live={data} />
        {!structured && (
          <DriverControls data={data} onDriver={onDriver} driverPending={driverPending} />
        )}
        {running ? stopButton : resume}
        {model !== null && (
          <span className="text-xs text-muted-foreground" data-testid="live-model">
            {model} · {effort}
          </span>
        )}
        {/* Items on an SSH host: copy ssh <target> and the working directory instead of Open in Finder (Contracts 31.3) */}
        {data.host === null ? (
          <FinderMenu items={finder} />
        ) : (
          <RemoteCopyMenu target={data.host.target} cwd={data.cwd} />
        )}
        <OpenInVscode
          liveId={liveId}
          serverId={data.host === null ? LOCAL_SERVER_ID : `ssh:${data.host.id}`}
        />
        <Button
          size="sm"
          variant={side ? 'secondary' : 'ghost'}
          aria-pressed={side}
          data-testid="toggle-side"
          title="Stages and requests"
          onClick={() => {
            setSide(!side);
          }}
        >
          <ChevronsLeftRight />
          <span data-toolbar-label>Stages and requests</span>
        </Button>
        {inOrca && (
          <TopologyButton
            open={drawer === 'topology'}
            onToggle={() => {
              setDrawer(drawer === 'topology' ? null : 'topology');
            }}
          />
        )}
        {draft !== null && (
          <>
            {draft.save}
            {sessionId !== null && <SessionCost sessionId={sessionId} />}
          </>
        )}
        <span className="ml-auto flex items-center gap-2">{extra}</span>
      </div>
      {/* The line below: the working directory truncates when it doesn't fit (full text on hover), staying on one line */}
      <p
        className="flex min-w-0 items-center gap-x-3 text-xs whitespace-nowrap text-muted-foreground"
        data-testid="live-meta"
      >
        {workflow !== null ? (
          <span className="font-mono" data-testid="live-workflow-name">
            /{workflow}
          </span>
        ) : (
          // Interactions without a command and items started from an existing session (Contracts 29.2)
          data.purpose === 'interaction' && (
            <span data-testid="live-workflow-name" title="No initial command">
              —
            </span>
          )
        )}
        <span>
          {draft === null ? 'Variant' : 'Base variant'}{' '}
          <span data-testid="live-variant-name">
            {draft === null ? variantLabel(data) : <BaseVariantName draft={draft.draft} />}
          </span>
        </span>
        {data.host !== null ? (
          <HostLabel label={data.host.label} className="shrink-0" />
        ) : draft === null ? (
          <span>{environmentLabel[data.environment]}</span>
        ) : (
          <span className="inline-flex items-center gap-1" data-testid="live-engine">
            <EngineLogo engine={data.engine} className="size-3.5" />
            {engineName[data.engine]}
          </span>
        )}
        <span className="min-w-0 truncate font-mono" title={data.cwd} data-testid="live-cwd">
          {data.cwd}
        </span>
        {draft === null ? (
          <>
            {data.repo !== null && <span className="font-mono">{data.repo}</span>}
            {data.ticket !== null && <span className="font-mono">{data.ticket}</span>}
          </>
        ) : (
          draft.meta
        )}
      </p>
      {draft?.below}
      <OrcaNotice live={data} />
      {errors}
      <Notices live={data} />
      <WorkRow fullscreen={fullscreen}>
        {draft !== null && data.draftId !== null ? (
          // Terminal on the left, workflow panel on the right, drawer far right, widths allotted by
          // DesignWork (Contracts 26.1); while the draft is still preparing, the terminal spot shows a
          // note and the panel still shows
          <DesignWork
            liveId={liveId}
            terminal={work}
            drawer={
              drawer !== null
                ? {
                    title: drawerTitle,
                    onClose: closeSide,
                    width: drawerWidth,
                    onResize: setDrawerWidth,
                    content: sideContent,
                  }
                : null
            }
          />
        ) : (
          <>
            {work}
            {drawer !== null && (
              <SideDrawer
                title={drawerTitle}
                onClose={closeSide}
                width={drawerWidth}
                onResize={setDrawerWidth}
              >
                {sideContent}
              </SideDrawer>
            )}
          </>
        )}
      </WorkRow>
    </div>
  );
}

// Magi Agent sessions (Contracts 23.6, 34.2): the toolbar has engine, config, driver and Hand back,
// Stop process or resume, worktree and branch status, deploy progress and the last deploy's result;
// the terminal can go full screen. On first open the terminal spot shows worktree preparation progress
function AgentPanel({
  data,
  stopButton,
  errors,
  fullscreen,
  extra,
  onResumed,
  onOpen,
  onDriver,
  driverPending,
}: PanelProps) {
  const magi = useMagiWorktree();
  const resume = useMutation({ mutationFn: () => resumeMagi(data.id), onSuccess: onResumed });
  const running = data.status === 'running';
  const state = magi.data;
  // Magi Agent can also dispatch workers with Orca (Contracts 35.4): the topology is in the right drawer
  const inOrca = useInOrcaRun(data);
  const [topology, setTopology] = useState(false);
  const [drawerWidth, setDrawerWidth] = useState(DRAWER_WIDTH);
  return (
    <div
      className="@container flex min-h-0 min-w-0 flex-1 flex-col gap-2"
      data-testid="live-panel"
      data-live={data.id}
      data-purpose="agent"
    >
      {/* When the panel is narrow, Hand back, Goal and Stop process show only icons with the name on hover; the toolbar stays on one row */}
      <div
        className="flex items-center gap-2 whitespace-nowrap @max-[54rem]:[&_[data-toolbar-label]]:sr-only"
        data-testid="live-toolbar"
      >
        <StatusBadge live={data} />
        <span
          className="magi-robot-host inline-flex items-center gap-1 text-sm font-medium"
          data-testid="live-engine"
        >
          <MagiRobot className="size-4" label="Magi Agent" />
          <EngineLogo engine={data.engine} className="size-4" />
          {engineName[data.engine]}
        </span>
        <span
          className="min-w-0 truncate text-sm text-muted-foreground"
          title={data.agentConfigName ?? undefined}
          data-testid="magi-config"
        >
          {data.agentConfigName}
        </span>
        <DriverControls data={data} onDriver={onDriver} driverPending={driverPending} />
        {running
          ? stopButton
          : data.process !== null && (
              <Button
                size="sm"
                variant="outline"
                data-testid="magi-resume"
                disabled={resume.isPending}
                onClick={() => {
                  resume.mutate();
                }}
              >
                <RotateCcw />
                resume
              </Button>
            )}
        <FinderMenu items={[{ label: 'worktree', target: { kind: 'live-cwd', id: data.id } }]} />
        <OpenInVscode liveId={data.id} />
        {inOrca && (
          <TopologyButton
            open={topology}
            onToggle={() => {
              setTopology(!topology);
            }}
          />
        )}
        {/* Branch status shortens in narrow windows (full text on hover); the toolbar stays on one row */}
        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          {state !== undefined && <BranchStatus worktree={state.worktree} />}
        </span>
        <span className="flex shrink-0 items-center gap-2">{extra}</span>
      </div>
      <p className="flex min-w-0 items-center gap-x-3 text-xs whitespace-nowrap text-muted-foreground">
        {state !== undefined && <DeployStatus deploy={state.deploy} />}
        <span className="min-w-0 truncate font-mono" title={data.cwd} data-testid="live-cwd">
          {data.cwd}
        </span>
      </p>
      {errors}
      {resume.error !== null && (
        <p role="alert" className="text-sm text-destructive">
          {resume.error.message}
        </p>
      )}
      {state?.worktree.startError != null && (
        <p
          role="alert"
          className="rounded-md border border-destructive px-3 py-1 text-sm text-destructive"
        >
          {state.worktree.startError}
        </p>
      )}
      <OrcaNotice live={data} />
      <Notices live={data} />
      <WorkRow fullscreen={fullscreen}>
        {data.process === null ? (
          state !== undefined && <WorktreePreparation magi={state} />
        ) : (
          <LiveTerminal key={data.process.id} liveId={data.id} />
        )}
        {topology && (
          <SideDrawer
            title="Topology"
            onClose={() => {
              setTopology(false);
            }}
            width={drawerWidth}
            onResize={setDrawerWidth}
          >
            <OrcaTopologyPanel live={data} onOpen={onOpen} />
          </SideDrawer>
        )}
      </WorkRow>
    </div>
  );
}

// Tab title: purpose color and engine logo before the name; Magi Agent items also get the little robot
function TabLabel({ liveId }: { liveId: string }) {
  const live = useQuery(liveQuery(liveId));
  if (live.data === undefined) return <>{liveId}</>;
  return (
    <span
      className="magi-robot-host flex min-w-0 items-center gap-1.5"
      title={purposeLabel(live.data)}
    >
      <PurposeBand purpose={live.data.purpose} className="h-4" />
      {live.data.purpose === 'agent' && <MagiRobot className="size-3.5" label="Magi Agent" />}
      <EngineLogo engine={live.data.engine} className="size-3.5" />
      {live.data.host !== null && (
        <Server
          className="size-3.5 shrink-0"
          aria-label={`SSH host ${live.data.host.label ?? ''}`}
        />
      )}
      <LiveTitle liveId={liveId} title={live.data.title} className="truncate" />
    </span>
  );
}

// Item switcher in full screen (Contracts 20.3): lists the items of the left list, each with its purpose color and engine logo
function ItemSwitcher({
  items,
  active,
  onSwitch,
}: {
  items: LiveSummary[];
  active: string;
  onSwitch: (id: string) => void;
}) {
  const current = items.find((i) => i.id === active);
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button
          size="sm"
          variant="outline"
          className="max-w-[18rem]"
          aria-label="Switch item"
          title={`Switch item (${SWITCH_SHORTCUT_LABEL})`}
          data-testid="live-switcher"
        >
          {current !== undefined && (
            <>
              <PurposeBand purpose={current.purpose} className="h-4" />
              <EngineLogo engine={current.engine} className="size-3.5" />
            </>
          )}
          <span className="truncate">{current?.title ?? active}</span>
          <ChevronDown />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="end"
          className="z-[60] max-h-[60vh] w-[20rem] overflow-y-auto rounded-md border bg-background p-1 shadow-md"
        >
          {items.map((item) => (
            <DropdownMenu.Item
              key={item.id}
              data-testid="live-switcher-item"
              data-live={item.id}
              aria-current={item.id === active}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none aria-[current=true]:font-medium data-[highlighted]:bg-muted"
              onSelect={() => {
                onSwitch(item.id);
              }}
            >
              <PurposeBand purpose={item.purpose} className="h-4" />
              <EngineLogo engine={item.engine} className="size-3.5" />
              <span className="min-w-0 flex-1 truncate">{item.title}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{purposeLabel(item)}</span>
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// The workspace (Contracts 14.3): list on the left, one tab per open session on the right; the terminal
// can go full screen (Contracts 20.3)
const LIST_COLLAPSED_KEY = 'wfd.live.listCollapsed';

export function LivePage() {
  useLiveSessionEvents();
  useSessionEvents();
  const fullscreen = useFullscreen();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const items = useQuery(liveListQuery(false));
  const open = (params.get('tabs') ?? '').split(',').filter((id) => id !== '');
  // ?item=<liveId>: selects that item's tab (the Sessions page "Live" button, resume and import all land here)
  const active = params.get('item') ?? open.at(-1) ?? null;
  const tabs = active !== null && !open.includes(active) ? [...open, active] : open;
  // Change only the tabs and selected item, keeping other URL params (?fullscreen=1)
  const update = (nextTabs: string[], nextActive: string | null) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (nextTabs.length > 0) next.set('tabs', nextTabs.join(','));
        else next.delete('tabs');
        if (nextActive !== null) next.set('item', nextActive);
        else next.delete('item');
        return next;
      },
      { replace: true },
    );
  };
  const openTab = (id: string) => {
    update(tabs.includes(id) ? tabs : [...tabs, id], id);
    setCreating(false);
  };
  const closeTab = (id: string) => {
    const rest = tabs.filter((t) => t !== id);
    update(rest, active === id ? (rest.at(-1) ?? null) : active);
  };

  // With no selected item there is no terminal to show full screen
  const { active: isFullscreen, exit } = fullscreen;
  useEffect(() => {
    if (isFullscreen && active === null) exit();
  }, [isFullscreen, active, exit]);

  // The left list collapses to a strip only when the user clicks "Collapse list", the same for items of
  // every purpose (Contracts 26.1); the choice is kept in localStorage
  const [listCompact, setListCompact] = useState(
    () => localStorage.getItem(LIST_COLLAPSED_KEY) === '1',
  );
  const chooseList = (compact: boolean) => {
    localStorage.setItem(LIST_COLLAPSED_KEY, compact ? '1' : '0');
    setListCompact(compact);
  };

  // ⌃⇧[ and ⌃⇧] in full screen: switch to the previous or next item in left-list order, staying full screen
  const switchRef = useRef<(direction: -1 | 1) => void>(() => undefined);
  useLayoutEffect(() => {
    switchRef.current = (direction) => {
      const list = items.data ?? [];
      if (list.length === 0) return;
      const at = list.findIndex((l) => l.id === active);
      const next = list[(at + direction + list.length) % list.length];
      if (next !== undefined) openTab(next.id);
    };
  });
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (event: KeyboardEvent) => {
      const direction = switchDirection(event);
      if (direction === null) return;
      event.preventDefault();
      event.stopPropagation();
      switchRef.current(direction);
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
    };
  }, [isFullscreen]);

  const extra = (
    <>
      {isFullscreen && active !== null && items.data !== undefined && (
        <ItemSwitcher items={items.data} active={active} onSwitch={openTab} />
      )}
      <FullscreenButton active={isFullscreen} onToggle={fullscreen.toggle} />
    </>
  );

  return (
    // Height is fixed to the window height (main has 2rem margins top and bottom); the terminal takes
    // what's left (Contracts 20.4). The height must be fixed: xterm.js computes rows from the container
    // size, and a container that grows with content keeps adding rows
    <div className="flex h-[calc(100vh-4rem)] flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-auto text-xl font-semibold">Live</h1>
        <ImportSessionsButton
          onImported={(imported) => {
            const last = imported.at(-1);
            if (last !== undefined) openTab(last.id);
          }}
        />
        <Button
          size="sm"
          variant={creating ? 'secondary' : 'default'}
          data-testid="new-live-toggle"
          onClick={() => {
            setCreating(!creating);
          }}
        >
          <Plus />
          New interaction
        </Button>
      </div>
      {creating && (
        <NewLiveForm
          onCreated={(live) => {
            openTab(live.id);
          }}
        />
      )}
      <div
        className={cn(
          'grid min-h-0 min-w-0 flex-1 gap-4',
          listCompact
            ? 'lg:grid-cols-[2.5rem_minmax(0,1fr)]'
            : 'lg:grid-cols-[15rem_minmax(0,1fr)]',
        )}
      >
        <aside
          className="flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto"
          data-testid="live-aside"
          data-compact={listCompact}
        >
          {listCompact ? (
            <CompactLiveList
              active={active}
              onOpen={openTab}
              onExpand={() => {
                chooseList(false);
              }}
            />
          ) : (
            <LiveList
              onOpen={openTab}
              onGone={closeTab}
              active={active}
              onCollapse={() => {
                chooseList(true);
              }}
            />
          )}
        </aside>
        <section className="flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto">
          {tabs.length === 0 ? (
            <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              Open a Live session from the list on the left, or start a new interaction.
            </p>
          ) : (
            <>
              <div
                role="tablist"
                aria-label="Open interactions"
                className="flex flex-wrap gap-1 border-b"
              >
                {tabs.map((id) => (
                  <div
                    key={id}
                    className="flex items-center rounded-t-md border border-b-0 aria-selected:bg-muted"
                    aria-selected={id === active}
                  >
                    <div
                      role="tab"
                      tabIndex={0}
                      aria-selected={id === active}
                      data-testid="live-tab"
                      data-live={id}
                      className="max-w-[16rem] cursor-pointer px-3 py-1.5 text-sm"
                      onClick={() => {
                        update(tabs, id);
                      }}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') update(tabs, id);
                      }}
                    >
                      <TabLabel liveId={id} />
                    </div>
                    <button
                      type="button"
                      aria-label="Close tab"
                      className="px-1.5 text-muted-foreground hover:text-foreground"
                      onClick={() => {
                        closeTab(id);
                      }}
                    >
                      <X className="size-3.5" />
                    </button>
                  </div>
                ))}
              </div>
              {active !== null && (
                // Full screen and normal are the same element: the terminal isn't remounted, content and cursor stay
                <FullscreenArea
                  active={isFullscreen}
                  className="flex min-h-0 min-w-0 flex-1 flex-col"
                  activeClassName="gap-2 p-3"
                  testId="live-fullscreen"
                >
                  <LivePanel
                    key={active}
                    liveId={active}
                    fullscreen={isFullscreen}
                    extra={extra}
                    onResumed={(live) => {
                      openTab(live.id);
                    }}
                    onOpen={openTab}
                  />
                </FullscreenArea>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
