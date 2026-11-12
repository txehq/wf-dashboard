import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkflowDefinition } from '@wf-dashboard/server/workflows/schema';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { StageFlow, type StageMark } from '@/components/workflow-flow';
import { cn } from '@/lib/utils';
import { useSize } from '@/lib/use-size';
import {
  againstOptions,
  useWorkspaceEvents,
  type Workspace,
  workspaceQuery,
} from '@/lib/workspace-api';
import { PanelSplitter } from './panel-splitter';
import { SideDrawer } from './side-drawer';
import { FileContent, FileTree } from './skill-browser';

// Workflow panel of design and optimize sessions (Contracts 26.2-26.4): the flowchart on top, the
// skill browser below, with a draggable divider between them; agent file changes refresh within 1 s via SSE

const FLOW_SHARE_KEY = 'wfd.workspace.flowShare';
const FLOW_MIN = 0.15;
const FLOW_MAX = 0.7;
const ONLY_CHANGED_KEY = 'wfd.workspace.onlyChanged';

function storedShare(): number {
  const raw = Number(localStorage.getItem(FLOW_SHARE_KEY) ?? '');
  return Number.isFinite(raw) && raw >= FLOW_MIN && raw <= FLOW_MAX ? raw : 0.26;
}

const skillFile = (id: string) => `skills/${id}/SKILL.md`;

// Widths of the terminal, panel and "Stages and requests" drawer (Contracts 26.1): the terminal is
// guaranteed 560 px (about 70 columns) first, and the panel and drawer share the rest.
// The panel is at least 340 px and defaults to 40% of the row; when the rest can't fit it, it collapses
// to a strip by default. The drawer is also at least 340 px; when both can't fit while it is open, the
// panel collapses to a strip temporarily and returns when the drawer closes. If the user opens the panel
// when it doesn't fit, the panel and drawer split the remaining width and the terminal stays at least
// 560 px. When the rest can't fit even a 340 px drawer, the drawer overlays the terminal's right side at 380 px
export const TERMINAL_MIN = 560;
export const PANEL_MIN = 340;
export const DRAWER_MIN = 340;
const OVERLAY_DRAWER_PX = 380;
const SPLITTER_PX = 8;
// The collapsed strip (w-7 plus ml-2) and the gap before the drawer (ml-3)
const STRIP_PX = 36;
const DRAWER_GAP_PX = 12;
const PANEL_SHARE_KEY = 'wfd.workspace.panelShare';
const PANEL_COLLAPSED_KEY = 'wfd.workspace.panelCollapsed';

function storedPanelShare(): number {
  const raw = Number(localStorage.getItem(PANEL_SHARE_KEY) ?? '');
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.4;
}

// Remembered once the user collapses or expands; until then, decided by whether the row fits
function storedCollapsed(): boolean | null {
  const raw = localStorage.getItem(PANEL_COLLAPSED_KEY);
  return raw === null ? null : raw === '1';
}

export interface DesignDrawer {
  title: string;
  onClose: () => void;
  // Width the user wants (changes after dragging); side by side, the shown width never exceeds what's left
  width: number;
  onResize: (width: number) => void;
  content: React.ReactNode;
}

// Terminal and panel of design and optimize sessions (Contracts 26.1): terminal on the left, panel on
// the right, a draggable divider between, and the panel collapses to a strip; the "Stages and
// requests" drawer is far right. In full screen they are all inside it (the row is in the full-screen area)
export function DesignWork({
  liveId,
  terminal,
  drawer,
}: {
  liveId: string;
  terminal: React.ReactNode;
  drawer: DesignDrawer | null;
}) {
  const row = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [share, setShare] = useState(storedPanelShare);
  const [collapsedChoice, setCollapsedChoice] = useState(storedCollapsed);
  // The user opened the panel while the drawer was open and both didn't fit; cleared when the drawer
  // closes (adjusted during render from the drawer state, not via an effect)
  const [openWithDrawer, setOpenWithDrawer] = useState(false);
  const drawerOpen = drawer !== null;
  const [drawerWasOpen, setDrawerWasOpen] = useState(drawerOpen);
  if (drawerWasOpen !== drawerOpen) {
    setDrawerWasOpen(drawerOpen);
    setOpenWithDrawer(false);
  }
  useLayoutEffect(() => {
    const element = row.current;
    if (element === null) throw new Error('The terminal row is not mounted');
    setWidth(element.clientWidth);
    // Like the terminal's fit, defer to the next frame to avoid repeated triggers in one layout pass
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setWidth(element.clientWidth);
      });
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, []);
  // The drawer sits beside the terminal when a 340 px drawer fits besides the 560 px terminal and the
  // collapsed panel strip; otherwise it overlays the terminal's right side at 380 px and the terminal
  // and panel layout stays as is
  const beside = drawerOpen && width - TERMINAL_MIN - STRIP_PX - DRAWER_GAP_PX >= DRAWER_MIN;
  const overlay = drawerOpen && !beside;
  // Width left after the terminal
  const spare = width - TERMINAL_MIN - (beside ? DRAWER_GAP_PX : 0);
  const panelFits = spare >= SPLITTER_PX + PANEL_MIN + (beside ? DRAWER_MIN : 0);
  const wanted = collapsedChoice === null ? panelFits : !collapsedChoice;
  const collapsed = !wanted || (beside && !panelFits && !openWithDrawer);
  // Width shared by the panel and drawer
  const rest = Math.max(0, spare - (collapsed ? STRIP_PX : SPLITTER_PX));
  const panelWanted = Math.max(PANEL_MIN, share * width);
  // Widest drawer: all of the rest when the panel is collapsed; with the panel open, leave the panel
  // its wanted width (at most half)
  const drawerCap = collapsed ? rest : rest - Math.min(panelWanted, rest / 2);
  const drawerWidth = beside ? Math.min(drawer.width, drawerCap) : 0;
  const maxPanel = Math.max(0, rest - drawerWidth);
  const panelWidth = Math.round(Math.min(maxPanel, panelWanted));
  const choose = (next: boolean) => {
    localStorage.setItem(PANEL_COLLAPSED_KEY, next ? '1' : '0');
    setCollapsedChoice(next);
    if (!next && beside) setOpenWithDrawer(true);
  };
  return (
    <div
      ref={row}
      className="relative flex min-h-0 min-w-0 flex-1"
      data-testid="design-work"
      data-panel={collapsed ? 'collapsed' : 'open'}
      data-drawer={overlay ? 'overlay' : beside ? 'beside' : 'closed'}
    >
      <div
        className="flex min-h-0 min-w-0 flex-1"
        style={{ minWidth: Math.min(TERMINAL_MIN, width) }}
        data-testid="design-terminal"
      >
        {terminal}
      </div>
      {collapsed ? (
        <button
          type="button"
          className="ml-2 flex w-7 shrink-0 flex-col items-center gap-2 rounded-md border py-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Expand workflow panel"
          title="Expand workflow panel"
          data-testid="ws-expand"
          onClick={() => {
            choose(false);
          }}
        >
          <PanelRightOpen className="size-4" />
          <span className="[writing-mode:vertical-rl]">Workflow</span>
        </button>
      ) : (
        <>
          <PanelSplitter
            orientation="vertical"
            label="Drag to resize the workflow panel"
            testId="ws-panel-splitter"
            onDrag={(x) => {
              const box = row.current?.getBoundingClientRect();
              if (box === undefined || box.width === 0) return;
              // The panel's right edge is left of the drawer
              const right = box.right - (beside ? drawerWidth + DRAWER_GAP_PX : 0);
              const next = Math.min(maxPanel, Math.max(PANEL_MIN, right - x));
              setShare(next / box.width);
            }}
            onEnd={() => {
              localStorage.setItem(PANEL_SHARE_KEY, String(share));
            }}
          />
          <aside
            aria-label="Workflow panel"
            className="flex min-h-0 shrink-0 flex-col rounded-md border bg-background"
            style={{ width: panelWidth }}
            data-testid="ws-panel"
          >
            <WorkflowPanel
              liveId={liveId}
              onCollapse={() => {
                choose(true);
              }}
            />
          </aside>
        </>
      )}
      {drawer !== null &&
        (beside ? (
          <SideDrawer
            className="ml-3"
            title={drawer.title}
            onClose={drawer.onClose}
            width={drawerWidth}
            onResize={drawer.onResize}
            maxWidth={drawerCap}
          >
            {drawer.content}
          </SideDrawer>
        ) : (
          // Overlays the terminal's right side outside the row layout: the terminal keeps its size and doesn't reflow
          <SideDrawer
            className="absolute inset-y-0 right-0 z-20 shadow-xl"
            title={drawer.title}
            onClose={drawer.onClose}
            width={OVERLAY_DRAWER_PX}
            resizable={false}
          >
            {drawer.content}
          </SideDrawer>
        ))}
    </div>
  );
}

interface GoodFlow {
  definition: WorkflowDefinition;
  stages: { id: string; status: StageMark }[];
}

export function WorkflowPanel({ liveId, onCollapse }: { liveId: string; onCollapse: () => void }) {
  const client = useQueryClient();
  const workspace = useQuery(workspaceQuery(liveId));
  const [selected, setSelected] = useState<string | null>(null);
  const [follow, setFollow] = useState(false);
  const [onlyChanged, setOnlyChanged] = useState(
    () => localStorage.getItem(ONLY_CHANGED_KEY) === '1',
  );
  const [ended, setEnded] = useState<string | null>(null);
  const [flowShare, setFlowShare] = useState(storedShare);
  const body = useRef<HTMLDivElement>(null);
  const [flowBox, flowSize] = useSize();
  const followRef = useRef(follow);
  useEffect(() => {
    followRef.current = follow;
  });

  // The last successfully parsed flowchart: still shown when workflow.yaml fails to parse, marked
  // "Outdated" (adjusted during render from new data, not via an effect)
  const [lastGood, setLastGood] = useState<GoodFlow | null>(null);
  const data = workspace.data;
  if (data !== undefined && 'definition' in data.workflow && data.workflow !== lastGood) {
    setLastGood(data.workflow);
  }

  // Open the entry skill on first load
  if (selected === null && data !== undefined) {
    const entry = 'definition' in data.workflow ? skillFile(data.workflow.definition.id) : null;
    const first = data.files.find((f) => f.path === entry) ?? data.files[0];
    if (first !== undefined) setSelected(first.path);
  }

  useWorkspaceEvents(liveId, (event) => {
    if (event.type === 'closed') {
      setEnded(
        event.reason === 'hidden'
          ? 'This item was closed; the panel no longer updates.'
          : 'This item was deleted.',
      );
      return;
    }
    if (event.type === 'failed') {
      setEnded(`Watching failed; the panel no longer updates: ${event.message}`);
      return;
    }
    void (async () => {
      await client.invalidateQueries({ queryKey: ['workspace', liveId] });
      if (!followRef.current) return;
      // Follow agent: switch to the most recently changed file in this change that is still in the working directory
      const tree = client.getQueryData<Workspace>(workspaceQuery(liveId).queryKey);
      const latest = (tree?.files ?? [])
        .filter((f) => event.paths.includes(f.path) && f.mtimeMs !== null)
        .sort((a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0))[0];
      if (latest !== undefined) setSelected(latest.path);
    })();
  });

  if (data === undefined) {
    return (
      <p
        className={cn(
          'p-3 text-sm',
          workspace.isError ? 'text-destructive' : 'text-muted-foreground',
        )}
      >
        {workspace.isError ? workspace.error.message : 'Loading…'}
      </p>
    );
  }
  const flow: GoodFlow | null = 'definition' in data.workflow ? data.workflow : lastGood;
  const error = 'error' in data.workflow ? data.workflow.error : null;
  const files = onlyChanged ? data.files.filter((f) => f.status !== 'unchanged') : data.files;
  const selectedStatus = data.files.find((f) => f.path === selected)?.status ?? null;
  const selectedStage =
    selected !== null && /^skills\/[^/]+\/SKILL\.md$/.test(selected)
      ? (selected.split('/')[1] ?? null)
      : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="workflow-panel">
      <div className="flex items-center gap-2 border-b px-2 py-1 text-xs">
        <span className="font-medium">Workflow</span>
        <span className="min-w-0 truncate font-mono text-muted-foreground" title={data.root}>
          {data.root}
        </span>
        <span className="text-muted-foreground" data-testid="ws-base">
          {data.base === null ? 'Blank' : `Base ${data.base.name}`}
        </span>
        {data.analysisId !== null && (
          <Link
            className="underline"
            to={`/analyses/${data.analysisId}`}
            data-testid="ws-analysis-link"
          >
            Analysis report
          </Link>
        )}
        <button
          type="button"
          className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="Collapse workflow panel"
          title="Collapse workflow panel"
          data-testid="ws-collapse"
          onClick={onCollapse}
        >
          <PanelRightClose className="size-4" />
        </button>
      </div>
      {ended !== null && (
        <p role="status" className="border-b px-2 py-1 text-xs text-muted-foreground">
          {ended}
        </p>
      )}
      <div ref={body} className="flex min-h-0 flex-1 flex-col">
        <section
          aria-label="Flowchart"
          className="flex min-h-0 flex-col gap-1 overflow-auto p-2"
          style={{ flexBasis: `${String(flowShare * 100)}%` }}
          data-testid="ws-flow"
          data-stale={error !== null}
        >
          {error !== null && (
            <pre
              role="alert"
              className="max-h-24 shrink-0 overflow-auto rounded bg-critical-muted p-2 font-mono text-xs whitespace-pre-wrap text-critical-muted-foreground"
              data-testid="ws-flow-error"
            >
              {error}
            </pre>
          )}
          {flow !== null && (
            // Measure the width and height left in this block (below the raw error) and scale the whole chart to fit
            <div
              ref={flowBox}
              className={cn('relative min-h-0 flex-1', error !== null && 'opacity-60')}
            >
              {error !== null && (
                <span className="absolute top-1 right-1 z-10 rounded bg-muted px-1.5 text-xs text-muted-foreground">
                  Outdated
                </span>
              )}
              <StageFlow
                definition={flow.definition}
                marks={Object.fromEntries(flow.stages.map((s) => [s.id, s.status]))}
                selected={selectedStage}
                compact
                // Fit by width only until this block's height is measured
                fitHeight={flowSize.height === 0 ? null : flowSize.height}
                onSelect={(id) => {
                  setSelected(skillFile(id));
                }}
              />
            </div>
          )}
        </section>
        <PanelSplitter
          orientation="horizontal"
          label="Drag to resize the flowchart"
          testId="ws-flow-splitter"
          onDrag={(y) => {
            const box = body.current?.getBoundingClientRect();
            if (box === undefined) return;
            const share = Math.min(FLOW_MAX, Math.max(FLOW_MIN, (y - box.top) / box.height));
            setFlowShare(share);
            localStorage.setItem(FLOW_SHARE_KEY, String(share));
          }}
        />
        <section aria-label="Skill browser" className="flex min-h-0 flex-1">
          <div className="flex w-36 shrink-0 flex-col border-r">
            <label className="flex items-center gap-1 border-b px-2 py-1 text-xs whitespace-nowrap text-muted-foreground">
              <input
                type="checkbox"
                data-testid="ws-only-changed"
                checked={onlyChanged}
                onChange={(event) => {
                  setOnlyChanged(event.target.checked);
                  localStorage.setItem(ONLY_CHANGED_KEY, event.target.checked ? '1' : '0');
                }}
              />
              Changed only
            </label>
            <div className="min-h-0 flex-1 overflow-auto py-1">
              <FileTree files={files} selected={selected} onSelect={setSelected} />
            </div>
          </div>
          <FileContent
            liveId={liveId}
            path={selected}
            status={selectedStatus}
            against={againstOptions(data)}
            toolbarEnd={
              <label
                className="flex items-center gap-1 text-xs whitespace-nowrap"
                title="When on, switches to the file the agent changed most recently"
              >
                <input
                  type="checkbox"
                  data-testid="ws-follow"
                  checked={follow}
                  onChange={(event) => {
                    setFollow(event.target.checked);
                  }}
                />
                Follow agent
              </label>
            }
          />
        </section>
      </div>
    </div>
  );
}
