import { useMutation, useQuery } from '@tanstack/react-query';
import {
  ChevronDown,
  ChevronsLeftRight,
  Hand,
  Plus,
  Power,
  RotateCcw,
  Undo2,
  X,
} from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { CodexDraftBar } from '@/components/codex-draft';
import { FullscreenArea, FullscreenButton, useFullscreen } from '@/components/fullscreen';
import { FinderMenu } from '@/components/live/finder-menu';
import { ImportSessionsButton } from '@/components/live/import-sessions';
import { HideButton, ItemMenu, UnhideButton } from '@/components/live/item-actions';
import {
  EngineLogo,
  PurposeBadge,
  PurposeBand,
  PurposeFilterBar,
} from '@/components/live/live-identity';
import { purposeLabel, usePurposeFilter } from '@/lib/live-purpose';
import { LiveTerminal } from '@/components/live/live-terminal';
import { LiveTitle } from '@/components/live/live-title';
import { BranchStatus, DeployStatus, WorktreePreparation } from '@/components/live/magi-parts';
import { NewLiveForm } from '@/components/live/new-live-form';
import { ResumeButton } from '@/components/live/resume-dialog';
import { SideDrawer } from '@/components/live/side-drawer';
import { SessionConversation } from '@/components/runs/conversation';
import { RequestTimeline } from '@/components/sessions/request-timeline';
import { StageBars } from '@/components/sessions/stage-bars';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import { newMagiSession, resumeMagi, useMagi } from '@/lib/magi-api';
import {
  type LiveDetail,
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

const environmentLabel = { isolated: 'isolated', real: 'real' } as const;
const driverLabel = { human: '人', simulated: '模拟用户' } as const;

// 全屏中切换交互项的快捷键（Contracts 20.3）：⌃⇧[ 上一项、⌃⇧] 下一项（macOS 上的 Control，不是 Command）。
// 与全屏的 ⌃⇧F 一样在 window 的捕获阶段拦下，终端收不到。终端本来就发不出这个组合（Control+[ 即 Esc，
// 加 Shift 也一样），Claude Code 与 Codex 都不会用到它；macOS 上的 Chrome 没有 Control+Shift+[ 与 ]
const SWITCH_SHORTCUT_LABEL = '⌃⇧[ / ⌃⇧]';
function switchDirection(event: KeyboardEvent): -1 | 1 | null {
  if (!event.ctrlKey || !event.shiftKey || event.metaKey || event.altKey) return null;
  if (event.code === 'BracketLeft') return -1;
  if (event.code === 'BracketRight') return 1;
  return null;
}

// 最近一次运行所用的配置；还没有运行过的项（从本机导入）没有
const variantLabel = (live: LiveSummary) =>
  live.process === null ? '—' : (live.variantName ?? '本机配置');

function StatusBadge({ live }: { live: LiveSummary }) {
  if (live.status === 'running') {
    return (
      <Badge data-testid="live-status" data-status="running">
        运行中
      </Badge>
    );
  }
  if (live.status === 'idle') {
    return (
      <Badge variant="secondary" data-testid="live-status" data-status="idle">
        未运行
      </Badge>
    );
  }
  const code = live.process?.exitCode ?? null;
  // 所有页面关闭后自动结束的（Contracts 14.3）：写明原因，不只显示退出码
  if (live.autoStopped) {
    return (
      <Badge
        variant="outline"
        data-testid="live-status"
        data-status="exited"
        data-auto-stopped="true"
        title="dashboard 的页面全部关闭后，进程被自动结束；resume 可以接着运行"
      >
        页面关闭后自动结束
      </Badge>
    );
  }
  return (
    <Badge variant="outline" data-testid="live-status" data-status="exited">
      已退出{code === null ? '' : `（${String(code)}）`}
    </Badge>
  );
}

// 左侧列表：有运行中进程的在前，其余按最近更新；每项显示名字、状态、variant、环境与 resume 次数。
// 每项可以"×"关闭（只隐藏）或从菜单删除；底部的开关列出已关闭的项（Contracts 14.5）
function LiveList({
  onOpen,
  onGone,
  active,
}: {
  onOpen: (id: string) => void;
  // 关闭或删除后：关掉它的标签页
  onGone: (id: string) => void;
  active: string | null;
}) {
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = usePurposeFilter();
  const list = useQuery(liveListQuery(showHidden));
  const magi = useMagi();
  const all = list.data ?? [];
  // 每种引擎的 Magi Agent 当前会话固定在最上面，在用途筛选之外，始终显示（Contracts 23.6）
  const pinnedIds = [magi.data?.current.codex, magi.data?.current.claude].filter(
    (id): id is string => typeof id === 'string',
  );
  const pinned = pinnedIds.flatMap((id) => all.filter((l) => l.id === id));
  const rest = all.filter((l) => !pinnedIds.includes(l.id));
  const shown = filter === 'all' ? rest : rest.filter((l) => l.purpose === filter);
  const counts = {
    all: all.length,
    interaction: all.filter((l) => l.purpose === 'interaction').length,
    design: all.filter((l) => l.purpose === 'design').length,
    optimize: all.filter((l) => l.purpose === 'optimize').length,
  };
  const item = (live: LiveSummary, isPinned: boolean) => {
    const hidden = live.hiddenAt !== null;
    return (
      <li key={live.id}>
        <div
          role="button"
          tabIndex={0}
          data-live={live.id}
          data-hidden={hidden}
          data-purpose={live.purpose}
          data-pinned={isPinned}
          aria-current={active === live.id}
          className="flex w-full cursor-pointer gap-2 rounded-md border py-2 pr-3 pl-1.5 text-left hover:bg-muted/50 aria-[current=true]:border-foreground data-[hidden=true]:border-dashed data-[hidden=true]:opacity-70"
          onClick={() => {
            onOpen(live.id);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') onOpen(live.id);
          }}
        >
          <PurposeBand purpose={live.purpose} />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="flex items-start gap-1">
              <EngineLogo engine={live.engine} className="mt-0.5 size-4" />
              <span className="min-w-0 flex-1">
                <LiveTitle
                  liveId={live.id}
                  title={live.title}
                  className="line-clamp-2 text-sm font-medium"
                />
              </span>
              <ItemMenu
                live={live}
                onDeleted={() => {
                  onGone(live.id);
                }}
              />
              {/* 当前会话始终显示，不能关闭 */}
              {!hidden && !isPinned && (
                <HideButton
                  live={live}
                  onHidden={() => {
                    onGone(live.id);
                  }}
                />
              )}
            </span>
            <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <PurposeBadge live={live} />
              <StatusBadge live={live} />
              {variantLabel(live)} · {environmentLabel[live.environment]} ·{' '}
              <span data-testid="live-resume-count">resume {live.resumeCount} 次</span>
            </span>
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
  if (list.isPending) body = <p className="text-sm text-muted-foreground">加载中…</p>;
  else if (list.isError) {
    body = (
      <p role="alert" className="text-sm text-destructive">
        {list.error.message}
      </p>
    );
  } else if (list.data.length === 0) {
    body = <p className="text-sm text-muted-foreground">还没有交互 session。</p>;
  } else if (shown.length === 0) {
    body =
      rest.length === 0 ? null : (
        <p className="text-sm text-muted-foreground">没有这种用途的项。</p>
      );
  } else {
    body = (
      <ul className="flex flex-col gap-1" aria-label="交互 session" data-testid="live-list">
        {shown.map((live) => item(live, false))}
      </ul>
    );
  }
  return (
    <>
      {pinned.length > 0 && (
        <ul className="flex flex-col gap-1" aria-label="Magi Agent" data-testid="live-pinned">
          {pinned.map((live) => item(live, true))}
        </ul>
      )}
      <PurposeFilterBar value={filter} onChange={setFilter} counts={counts} />
      {body}
      <label className="flex items-center gap-2 px-1 text-xs text-muted-foreground">
        <input
          type="checkbox"
          data-testid="show-hidden"
          checked={showHidden}
          onChange={(event) => {
            setShowHidden(event.target.checked);
          }}
        />
        显示已关闭的项
      </label>
    </>
  );
}

// 终端旁边的阶段条与请求明细（复用 Sessions 详情的组件）
function SessionSide({ sessionId }: { sessionId: string }) {
  const session = useQuery(sessionQuery(sessionId));
  const stages = useQuery(stagesQuery(sessionId));
  if (session.data === undefined || stages.data === undefined) {
    return (
      <p className="text-sm text-muted-foreground">
        {session.isPending || stages.isPending
          ? '正在读取 session…'
          : 'session 还没有导入（Claude Code 写出第一条记录后出现）。'}
      </p>
    );
  }
  const workflows = stages.data.workflows.filter((w) => w.cycles.length > 0);
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="live-side">
      {workflows.length === 0 && (
        <p className="text-sm text-muted-foreground">
          还没有进入 {stages.data.workflows.map((w) => `/${w.workflow}`).join(' 或 ')} 的阶段。
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
        <h3 className="text-sm font-semibold">请求明细</h3>
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

function Notices({ live }: { live: LiveDetail }) {
  const notice = 'rounded-md border px-3 py-1 text-sm';
  return (
    <>
      {live.autoStopped && (
        <p role="status" className={notice} data-testid="live-auto-stopped">
          页面全部关闭后，这个进程被自动结束。下面是结束时的终端输出，点 resume 接着运行。
        </p>
      )}
      {live.starting && (
        <p role="status" className={notice} data-testid="live-starting">
          启动中，终端中的确认由你回答。
        </p>
      )}
      {live.handedBack === 'done' && (
        <p role="status" className={notice} data-testid="live-done">
          模拟用户认为已结束。
        </p>
      )}
      {live.handedBack === 'max-turns' && (
        <p role="status" className={notice}>
          模拟用户回答次数达到上限，已交给你。
        </p>
      )}
      {live.error !== null && (
        <p role="alert" className={cn(notice, 'border-destructive text-destructive')}>
          {live.error}
        </p>
      )}
    </>
  );
}

// 终端（或还没运行过的项的对话）与右侧的抽屉占一行，占满工具栏以下的空间（不全屏时为页面剩下的高度）
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
  fullscreen,
  extra,
}: {
  liveId: string;
  // resume 落在同一项（Contracts 14.5）：交互区选中它的标签页
  onResumed: (live: LiveDetail) => void;
  fullscreen: boolean;
  // 工具栏最右边：全屏中切换交互项的下拉与全屏按钮
  extra: ReactNode;
}) {
  const live = useQuery(liveQuery(liveId));
  const [side, setSide] = useState(false);
  const driver = useMutation({
    mutationFn: (next: 'human' | 'simulated') => setLiveDriver(liveId, next),
  });
  const stopping = useMutation({ mutationFn: () => stopLive(liveId) });
  if (live.data === undefined) {
    return live.isError ? (
      <p role="alert" className="text-sm text-destructive">
        {live.error.message}
      </p>
    ) : (
      <p className="text-sm text-muted-foreground">加载中…</p>
    );
  }
  const data = live.data;
  const running = data.status === 'running';
  const stopButton = (
    <Button
      size="sm"
      variant="outline"
      disabled={stopping.isPending}
      onClick={() => {
        stopping.mutate();
      }}
    >
      <Power />
      结束进程
    </Button>
  );
  const errors = (driver.isError || stopping.isError) && (
    <p role="alert" className="text-sm text-destructive">
      {(driver.error ?? stopping.error)?.message}
    </p>
  );
  const panelClass = 'flex min-h-0 min-w-0 flex-1 flex-col gap-2';
  if (data.purpose === 'agent') {
    return (
      <AgentPanel
        data={data}
        stopButton={stopButton}
        errors={errors}
        fullscreen={fullscreen}
        extra={extra}
        onResumed={onResumed}
      />
    );
  }
  if (data.purpose === 'design' || data.purpose === 'optimize') {
    // 设计 workflow 或 variant、分析优化的会话（Contracts 17.3、22）：Codex 或 Claude Code，只有人驾驶，
    // 没有阶段与请求明细
    const codex = data.engine === 'codex';
    return (
      <div className={panelClass} data-testid="live-panel" data-live={liveId}>
        <div className="flex flex-wrap items-center gap-2 text-sm" data-testid="live-toolbar">
          <StatusBadge live={data} />
          <span className="font-medium" data-testid="live-engine">
            {codex ? 'Codex' : 'Claude Code'}
          </span>
          {running && stopButton}
          <FinderMenu
            items={[
              {
                label: data.purpose === 'optimize' ? '分析目录' : '草稿目录',
                target: { kind: 'live-cwd', id: liveId },
              },
              {
                label: codex ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR',
                target: { kind: 'live-config', id: liveId },
              },
            ]}
          />
          <span
            className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground"
            title={data.cwd}
            data-testid="live-cwd"
          >
            {data.cwd}
          </span>
          {extra}
        </div>
        {errors}
        <Notices live={data} />
        <CodexDraftBar live={data} onResumed={onResumed} />
        {data.process !== null && (
          <WorkRow fullscreen={fullscreen}>
            <LiveTerminal key={data.process.id} liveId={liveId} />
          </WorkRow>
        )}
      </div>
    );
  }
  // 交互的项建出时就有 session id（只有设计与分析优化的项在第一次启动前为空）
  const sessionId = data.claudeSessionId;
  if (sessionId === null) throw new Error(`交互 ${liveId} 没有 session id`);
  const model = data.process?.model ?? null;
  const effort = data.process?.effort ?? null;
  return (
    <div className={panelClass} data-testid="live-panel" data-live={liveId}>
      {/* 工具栏（Contracts 20.3、20.4）：全部按钮在同一行，全屏时同样保留 */}
      <div className="flex flex-wrap items-center gap-2" data-testid="live-toolbar">
        <StatusBadge live={data} />
        <div
          role="radiogroup"
          aria-label="驾驶者"
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
              disabled={!running || data.starting || driver.isPending || data.driver === d}
              className="rounded px-2.5 py-0.5 text-sm aria-checked:bg-foreground aria-checked:text-background disabled:cursor-not-allowed"
              onClick={() => {
                driver.mutate(d);
              }}
            >
              {d === 'human' ? <Hand className="mr-1 inline size-3.5" /> : null}
              {driverLabel[d]}
            </button>
          ))}
        </div>
        <Button
          size="sm"
          variant="outline"
          data-testid="hand-back"
          title="交还给模拟用户"
          disabled={!running || data.starting || data.driver === 'simulated' || driver.isPending}
          onClick={() => {
            driver.mutate('simulated');
          }}
        >
          <Undo2 />
          交还
        </Button>
        {running
          ? stopButton
          : data.process !== null && <ResumeButton sessionId={sessionId} onResumed={onResumed} />}
        {model !== null && (
          <span className="text-xs text-muted-foreground" data-testid="live-model">
            {model} · {effort}
          </span>
        )}
        <FinderMenu
          items={[
            { label: '工作目录', target: { kind: 'live-cwd', id: liveId } },
            { label: '配置目录', target: { kind: 'live-config', id: liveId } },
          ]}
        />
        <Button
          size="sm"
          variant={side ? 'secondary' : 'ghost'}
          aria-pressed={side}
          data-testid="toggle-side"
          onClick={() => {
            setSide(!side);
          }}
        >
          <ChevronsLeftRight />
          阶段与请求
        </Button>
        <span className="ml-auto flex items-center gap-2">{extra}</span>
      </div>
      <p className="flex min-w-0 flex-wrap items-center gap-x-3 text-xs text-muted-foreground">
        {data.workflow !== null && (
          <span className="font-mono" data-testid="live-workflow-name">
            /{data.workflow}
          </span>
        )}
        <span>
          variant <span data-testid="live-variant-name">{variantLabel(data)}</span>
        </span>
        <span>{environmentLabel[data.environment]}</span>
        <span className="min-w-0 truncate font-mono" title={data.cwd} data-testid="live-cwd">
          {data.cwd}
        </span>
        {data.repo !== null && <span className="font-mono">{data.repo}</span>}
        {data.ticket !== null && <span className="font-mono">{data.ticket}</span>}
      </p>
      {errors}
      <Notices live={data} />
      <WorkRow fullscreen={fullscreen}>
        {data.process === null ? (
          // 从本机导入、还没有运行过（Contracts 14.5）：显示这个 session 的对话与 resume 按钮
          <div
            className="flex min-w-0 flex-1 flex-col gap-3 overflow-y-auto rounded-md border p-4"
            data-testid="live-idle"
          >
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">
                这个 session 还没有在交互区运行过，resume 后在这里接着对话。
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
        ) : (
          // resume 在同一项上起新进程：按进程重建终端，重新连接并回放这一项的输出
          <LiveTerminal key={data.process.id} liveId={liveId} />
        )}
        {side && (
          <SideDrawer
            title="阶段与请求"
            onClose={() => {
              setSide(false);
            }}
          >
            <SessionSide sessionId={sessionId} />
          </SideDrawer>
        )}
      </WorkRow>
    </div>
  );
}

// Magi Agent 的会话（Contracts 23.6）：只有人驾驶；工具栏是引擎、结束进程或 resume、新会话、worktree 与分支状态、
// 部署的进度与上一次部署的结果；终端可以全屏。第一次打开时终端的位置显示 worktree 的准备进度
const engineName = { claude: 'Claude Code', codex: 'Codex' } as const;

function AgentPanel({
  data,
  stopButton,
  errors,
  fullscreen,
  extra,
  onResumed,
}: {
  data: LiveDetail;
  stopButton: ReactNode;
  errors: ReactNode;
  fullscreen: boolean;
  extra: ReactNode;
  onResumed: (live: LiveDetail) => void;
}) {
  const magi = useMagi();
  const resume = useMutation({ mutationFn: () => resumeMagi(data.id), onSuccess: onResumed });
  const fresh = useMutation({
    mutationFn: () => newMagiSession(data.engine),
    onSuccess: onResumed,
  });
  const running = data.status === 'running';
  const state = magi.data;
  const current = state?.current[data.engine] === data.id;
  const failure = resume.error ?? fresh.error;
  return (
    <div
      className="flex min-h-0 min-w-0 flex-1 flex-col gap-2"
      data-testid="live-panel"
      data-live={data.id}
      data-purpose="agent"
    >
      <div className="flex items-center gap-2 whitespace-nowrap" data-testid="live-toolbar">
        <StatusBadge live={data} />
        <span
          className="inline-flex items-center gap-1 text-sm font-medium"
          data-testid="live-engine"
        >
          <EngineLogo engine={data.engine} className="size-4" />
          {engineName[data.engine]}
        </span>
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
        <Button
          size="sm"
          variant="outline"
          data-testid="magi-new"
          title={`新建一个 ${engineName[data.engine]} 的 Magi Agent 会话，记为当前会话`}
          disabled={fresh.isPending}
          onClick={() => {
            fresh.mutate();
          }}
        >
          <Plus />
          新会话
        </Button>
        <FinderMenu items={[{ label: 'worktree', target: { kind: 'live-cwd', id: data.id } }]} />
        {/* 分支状态在窄的窗口中缩短（悬停看全文），工具栏保持一行 */}
        <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden">
          {state !== undefined && <BranchStatus worktree={state.worktree} />}
        </span>
        <span className="flex shrink-0 items-center gap-2">{extra}</span>
      </div>
      <p className="flex min-w-0 items-center gap-x-3 text-xs whitespace-nowrap text-muted-foreground">
        <span data-testid="magi-current">{current ? '当前会话' : '之前的会话'}</span>
        <span>本机配置</span>
        {state !== undefined && <DeployStatus deploy={state.deploy} />}
        <span className="min-w-0 truncate font-mono" title={data.cwd} data-testid="live-cwd">
          {data.cwd}
        </span>
      </p>
      {errors}
      {failure !== null && (
        <p role="alert" className="text-sm text-destructive">
          {failure.message}
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
      <Notices live={data} />
      <WorkRow fullscreen={fullscreen}>
        {data.process === null ? (
          state !== undefined && <WorktreePreparation magi={state} />
        ) : (
          <LiveTerminal key={data.process.id} liveId={data.id} />
        )}
      </WorkRow>
    </div>
  );
}

// 标签页标题：用途的颜色与引擎的 logo 在名字前面
function TabLabel({ liveId }: { liveId: string }) {
  const live = useQuery(liveQuery(liveId));
  if (live.data === undefined) return <>{liveId}</>;
  return (
    <span className="flex min-w-0 items-center gap-1.5" title={purposeLabel(live.data)}>
      <PurposeBand purpose={live.data.purpose} className="h-4" />
      <EngineLogo engine={live.data.engine} className="size-3.5" />
      <LiveTitle liveId={liveId} title={live.data.title} className="truncate" />
    </span>
  );
}

// 全屏中切换交互项的下拉（Contracts 20.3）：列出左侧列表中的项，每项同样显示用途的颜色与引擎的 logo
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
          aria-label="切换交互项"
          title={`切换交互项（${SWITCH_SHORTCUT_LABEL}）`}
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

// 交互区（Contracts 14.3）：左侧列表，右侧每个打开的 session 一个标签页；终端可以全屏（Contracts 20.3）
export function LivePage() {
  useLiveSessionEvents();
  useSessionEvents();
  const fullscreen = useFullscreen();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const items = useQuery(liveListQuery(false));
  const open = (params.get('tabs') ?? '').split(',').filter((id) => id !== '');
  // ?item=<liveId>：选中这一项的标签页（Sessions 页面的"Live"按钮、resume 与导入都跳到这里）
  const active = params.get('item') ?? open.at(-1) ?? null;
  const tabs = active !== null && !open.includes(active) ? [...open, active] : open;
  // 只改标签页与选中的项，保留地址中的其他参数（?fullscreen=1）
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

  // 没有选中的项时没有可以全屏的终端
  const { active: isFullscreen, exit } = fullscreen;
  useEffect(() => {
    if (isFullscreen && active === null) exit();
  }, [isFullscreen, active, exit]);

  // 全屏中的 ⌃⇧[ 与 ⌃⇧]：按左侧列表的顺序切换到上一项或下一项，保持全屏
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
    // 高度固定为窗口的高度（main 上下各 2rem 的边距），终端占其中剩下的部分（Contracts 20.4）。
    // 高度必须是定值：xterm.js 按容器大小算行数，容器随内容长高会让行数不断增加
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
          新建交互
        </Button>
      </div>
      {creating && (
        <NewLiveForm
          onCreated={(live) => {
            openTab(live.id);
          }}
        />
      )}
      <div className="grid min-h-0 min-w-0 flex-1 gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <aside className="flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto">
          <LiveList onOpen={openTab} onGone={closeTab} active={active} />
        </aside>
        <section className="flex min-h-0 min-w-0 flex-col gap-2 overflow-y-auto">
          {tabs.length === 0 ? (
            <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
              从左侧打开一个交互 session，或新建一个。
            </p>
          ) : (
            <>
              <div role="tablist" aria-label="打开的交互" className="flex flex-wrap gap-1 border-b">
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
                      aria-label="关闭标签页"
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
                // 全屏与不全屏是同一个元素：终端不重新挂载，内容与光标不变
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
