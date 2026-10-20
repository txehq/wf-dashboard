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

// 设计与优化会话的 workflow 面板（Contracts 26.2–26.4）：上半部分是流程图，下半部分是 skill 浏览，两者之间的
// 分隔可以拖动；agent 改了文件后经 SSE 在 1 秒内刷新

const FLOW_SHARE_KEY = 'wfd.workspace.flowShare';
const FLOW_MIN = 0.15;
const FLOW_MAX = 0.7;
const ONLY_CHANGED_KEY = 'wfd.workspace.onlyChanged';

function storedShare(): number {
  const raw = Number(localStorage.getItem(FLOW_SHARE_KEY) ?? '');
  return Number.isFinite(raw) && raw >= FLOW_MIN && raw <= FLOW_MAX ? raw : 0.26;
}

const skillFile = (id: string) => `skills/${id}/SKILL.md`;

// 终端、面板与"阶段与请求"抽屉的宽度（Contracts 26.1）：终端先保证 560 px（约 70 列），面板与抽屉分剩下的宽度。
// 面板最小 340 px、默认占这一行的 40%，剩下的宽度放不下时默认收成窄边；抽屉同样最小 340 px，打开时放不下两者
// 则面板暂时收成窄边，抽屉关上后恢复。用户在放不下时点开面板，面板与抽屉按剩余宽度给，终端仍不小于 560 px。
// 剩下的宽度连 340 px 的抽屉都放不下时，抽屉以 380 px 覆盖在终端右侧
export const TERMINAL_MIN = 560;
export const PANEL_MIN = 340;
export const DRAWER_MIN = 340;
const OVERLAY_DRAWER_PX = 380;
const SPLITTER_PX = 8;
// 收起的窄边（w-7 加 ml-2）与抽屉前的间隔（ml-3）
const STRIP_PX = 36;
const DRAWER_GAP_PX = 12;
const PANEL_SHARE_KEY = 'wfd.workspace.panelShare';
const PANEL_COLLAPSED_KEY = 'wfd.workspace.panelCollapsed';

function storedPanelShare(): number {
  const raw = Number(localStorage.getItem(PANEL_SHARE_KEY) ?? '');
  return Number.isFinite(raw) && raw > 0 && raw < 1 ? raw : 0.4;
}

// 用户收起或展开过时记住；没有操作过时按这一行放不放得下决定
function storedCollapsed(): boolean | null {
  const raw = localStorage.getItem(PANEL_COLLAPSED_KEY);
  return raw === null ? null : raw === '1';
}

export interface DesignDrawer {
  title: string;
  onClose: () => void;
  // 用户想要的宽度（拖动后改变）；并排时显示的宽度不超过剩下的宽度
  width: number;
  onResize: (width: number) => void;
  content: React.ReactNode;
}

// 设计与优化会话的终端与面板（Contracts 26.1）：终端在左，面板在右，中间的分隔条可以拖动，面板可以收起成窄边；
// "阶段与请求"的抽屉在最右边。全屏时都在全屏中（这一行在全屏区域内）
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
  // 抽屉打开着、放不下两者时用户点开了面板；抽屉关上时清除（渲染时按抽屉的开关调整，不经 effect）
  const [openWithDrawer, setOpenWithDrawer] = useState(false);
  const drawerOpen = drawer !== null;
  const [drawerWasOpen, setDrawerWasOpen] = useState(drawerOpen);
  if (drawerWasOpen !== drawerOpen) {
    setDrawerWasOpen(drawerOpen);
    setOpenWithDrawer(false);
  }
  useLayoutEffect(() => {
    const element = row.current;
    if (element === null) throw new Error('终端这一行没有挂载');
    setWidth(element.clientWidth);
    // 与终端的 fit 相同放到下一帧，避免在同一次布局中反复触发
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
  // 抽屉与终端并排的条件：终端 560 px、面板收成窄边之外还放得下 340 px 的抽屉；放不下时抽屉以 380 px 覆盖在
  // 终端右侧，终端与面板的布局照旧
  const beside = drawerOpen && width - TERMINAL_MIN - STRIP_PX - DRAWER_GAP_PX >= DRAWER_MIN;
  const overlay = drawerOpen && !beside;
  // 终端之外剩下的宽度
  const spare = width - TERMINAL_MIN - (beside ? DRAWER_GAP_PX : 0);
  const panelFits = spare >= SPLITTER_PX + PANEL_MIN + (beside ? DRAWER_MIN : 0);
  const wanted = collapsedChoice === null ? panelFits : !collapsedChoice;
  const collapsed = !wanted || (beside && !panelFits && !openWithDrawer);
  // 面板与抽屉分的宽度
  const rest = Math.max(0, spare - (collapsed ? STRIP_PX : SPLITTER_PX));
  const panelWanted = Math.max(PANEL_MIN, share * width);
  // 抽屉最宽：面板收起时是剩下的全部，面板展开时给面板留下它想要的宽度（最多一半）
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
          aria-label="展开 workflow 面板"
          title="展开 workflow 面板"
          data-testid="ws-expand"
          onClick={() => {
            choose(false);
          }}
        >
          <PanelRightOpen className="size-4" />
          <span className="[writing-mode:vertical-rl]">workflow</span>
        </button>
      ) : (
        <>
          <PanelSplitter
            orientation="vertical"
            label="拖动调整 workflow 面板的宽度"
            testId="ws-panel-splitter"
            onDrag={(x) => {
              const box = row.current?.getBoundingClientRect();
              if (box === undefined || box.width === 0) return;
              // 面板的右边缘在抽屉左边
              const right = box.right - (beside ? drawerWidth + DRAWER_GAP_PX : 0);
              const next = Math.min(maxPanel, Math.max(PANEL_MIN, right - x));
              setShare(next / box.width);
            }}
            onEnd={() => {
              localStorage.setItem(PANEL_SHARE_KEY, String(share));
            }}
          />
          <aside
            aria-label="workflow 面板"
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
          // 覆盖在终端右侧，不参与这一行的布局：终端不改变大小、不重排
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

  // 上一次成功解析的流程图：workflow.yaml 解析失败时照样显示，标"已过期"（渲染时按新数据调整，不经 effect）
  const [lastGood, setLastGood] = useState<GoodFlow | null>(null);
  const data = workspace.data;
  if (data !== undefined && 'definition' in data.workflow && data.workflow !== lastGood) {
    setLastGood(data.workflow);
  }

  // 第一次读到时打开入口 skill
  if (selected === null && data !== undefined) {
    const entry = 'definition' in data.workflow ? skillFile(data.workflow.definition.id) : null;
    const first = data.files.find((f) => f.path === entry) ?? data.files[0];
    if (first !== undefined) setSelected(first.path);
  }

  useWorkspaceEvents(liveId, (event) => {
    if (event.type === 'closed') {
      setEnded(event.reason === 'hidden' ? '这一项已关闭，面板不再更新。' : '这一项已删除。');
      return;
    }
    if (event.type === 'failed') {
      setEnded(`监视出错，面板不再更新：${event.message}`);
      return;
    }
    void (async () => {
      await client.invalidateQueries({ queryKey: ['workspace', liveId] });
      if (!followRef.current) return;
      // 跟随 agent：切到这次变化中最近改的、还在工作目录中的文件
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
        {workspace.isError ? workspace.error.message : '加载中…'}
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
        <span className="font-medium">workflow</span>
        <span className="min-w-0 truncate font-mono text-muted-foreground" title={data.root}>
          {data.root}
        </span>
        <span className="text-muted-foreground" data-testid="ws-base">
          {data.base === null ? '空白新建' : `底子 ${data.base.name}`}
        </span>
        {data.analysisId !== null && (
          <Link
            className="underline"
            to={`/analyses/${data.analysisId}`}
            data-testid="ws-analysis-link"
          >
            分析报告
          </Link>
        )}
        <button
          type="button"
          className="ml-auto rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          aria-label="收起 workflow 面板"
          title="收起 workflow 面板"
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
          aria-label="流程图"
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
            // 量这一块剩下的宽与高（原文错误之下），整张图缩放到其中可见
            <div
              ref={flowBox}
              className={cn('relative min-h-0 flex-1', error !== null && 'opacity-60')}
            >
              {error !== null && (
                <span className="absolute top-1 right-1 z-10 rounded bg-muted px-1.5 text-xs text-muted-foreground">
                  已过期
                </span>
              )}
              <StageFlow
                definition={flow.definition}
                marks={Object.fromEntries(flow.stages.map((s) => [s.id, s.status]))}
                selected={selectedStage}
                compact
                // 量出这一块的高度之前只按宽度
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
          label="拖动调整流程图的高度"
          testId="ws-flow-splitter"
          onDrag={(y) => {
            const box = body.current?.getBoundingClientRect();
            if (box === undefined) return;
            const share = Math.min(FLOW_MAX, Math.max(FLOW_MIN, (y - box.top) / box.height));
            setFlowShare(share);
            localStorage.setItem(FLOW_SHARE_KEY, String(share));
          }}
        />
        <section aria-label="skill 浏览" className="flex min-h-0 flex-1">
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
              只看改动的
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
                title="打开时自动切到 agent 最近改的文件"
              >
                <input
                  type="checkbox"
                  data-testid="ws-follow"
                  checked={follow}
                  onChange={(event) => {
                    setFollow(event.target.checked);
                  }}
                />
                跟随 agent
              </label>
            }
          />
        </section>
      </div>
    </div>
  );
}
