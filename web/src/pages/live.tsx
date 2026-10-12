import { useMutation, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, Hand, Plus, Power, Undo2, X } from 'lucide-react';
import { useState } from 'react';
import { useSearchParams } from 'react-router';
import { ImportSessionsButton } from '@/components/live/import-sessions';
import { LiveTerminal } from '@/components/live/live-terminal';
import { LiveTitle } from '@/components/live/live-title';
import { NewLiveForm } from '@/components/live/new-live-form';
import { ResumeButton } from '@/components/live/resume-dialog';
import { SessionConversation } from '@/components/runs/conversation';
import { RequestTimeline } from '@/components/sessions/request-timeline';
import { StageBars } from '@/components/sessions/stage-bars';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
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

const environmentLabel = { isolated: 'isolated', real: 'real' } as const;
const driverLabel = { human: '人', simulated: '模拟用户' } as const;

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
  return (
    <Badge variant="outline" data-testid="live-status" data-status="exited">
      已退出{code === null ? '' : `（${String(code)}）`}
    </Badge>
  );
}

// 左侧列表：有运行中进程的在前，其余按最近更新；每项显示名字、状态、variant、环境与 resume 次数
function LiveList({ onOpen, active }: { onOpen: (id: string) => void; active: string | null }) {
  const list = useQuery(liveListQuery);
  if (list.isPending) return <p className="text-sm text-muted-foreground">加载中…</p>;
  if (list.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {list.error.message}
      </p>
    );
  }
  if (list.data.length === 0) {
    return <p className="text-sm text-muted-foreground">还没有交互 session。</p>;
  }
  return (
    <ul className="flex flex-col gap-1" aria-label="交互 session" data-testid="live-list">
      {list.data.map((live) => (
        <li key={live.id}>
          <div
            role="button"
            tabIndex={0}
            data-live={live.id}
            aria-current={active === live.id}
            className="flex w-full cursor-pointer flex-col gap-0.5 rounded-md border px-3 py-2 text-left hover:bg-muted/50 aria-[current=true]:border-foreground"
            onClick={() => {
              onOpen(live.id);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onOpen(live.id);
            }}
          >
            <LiveTitle
              liveId={live.id}
              title={live.title}
              className="line-clamp-2 text-sm font-medium"
            />
            <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
              <StatusBadge live={live} />
              {variantLabel(live)} · {environmentLabel[live.environment]} ·{' '}
              <span data-testid="live-resume-count">resume {live.resumeCount} 次</span>
            </span>
            <span className="text-xs text-muted-foreground">
              {formatDateTime(new Date(live.updatedAt).toISOString())}
            </span>
          </div>
        </li>
      ))}
    </ul>
  );
}

// 终端旁边可展开的阶段条与请求明细（复用 Sessions 详情的组件）
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
  const cycles = [...stages.data.lfg, ...stages.data.ic];
  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="live-side">
      {cycles.length === 0 && (
        <p className="text-sm text-muted-foreground">还没有进入 /lfg 或 /ic 的阶段。</p>
      )}
      {cycles.map((cycle) => (
        <section key={`${cycle.label}-${String(cycle.index)}`} className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">{cycleName(cycle)}</h3>
          <StageBars views={cycle.stages} />
        </section>
      ))}
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
  return (
    <>
      {live.starting && (
        <p
          role="status"
          className="rounded-md border px-3 py-2 text-sm"
          data-testid="live-starting"
        >
          启动中，终端中的确认由你回答。
        </p>
      )}
      {live.handedBack === 'done' && (
        <p role="status" className="rounded-md border px-3 py-2 text-sm" data-testid="live-done">
          模拟用户认为已结束。
        </p>
      )}
      {live.handedBack === 'max-turns' && (
        <p role="status" className="rounded-md border px-3 py-2 text-sm">
          模拟用户回答次数达到上限，已交给你。
        </p>
      )}
      {live.error !== null && (
        <p
          role="alert"
          className="rounded-md border border-destructive px-3 py-2 text-sm text-destructive"
        >
          {live.error}
        </p>
      )}
    </>
  );
}

function LivePanel({
  liveId,
  onResumed,
}: {
  liveId: string;
  // resume 落在同一项（Contracts 14.5）：交互区选中它的标签页
  onResumed: (live: LiveDetail) => void;
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
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="live-panel" data-live={liveId}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
        <StatusBadge live={data} />
        <span>
          variant：<span data-testid="live-variant-name">{variantLabel(data)}</span>
        </span>
        <span>环境：{environmentLabel[data.environment]}</span>
        <span className="min-w-0 font-mono text-xs break-all" data-testid="live-cwd">
          {data.cwd}
        </span>
        {data.repo !== null && <span className="font-mono text-xs">{data.repo}</span>}
        {data.ticket !== null && <span className="font-mono text-xs">{data.ticket}</span>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
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
              className="rounded px-3 py-1 text-sm aria-checked:bg-foreground aria-checked:text-background disabled:cursor-not-allowed"
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
          disabled={!running || data.starting || data.driver === 'simulated' || driver.isPending}
          onClick={() => {
            driver.mutate('simulated');
          }}
        >
          <Undo2 />
          交还给模拟用户
        </Button>
        {running ? (
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
        ) : data.process === null ? null : (
          <ResumeButton sessionId={data.claudeSessionId} onResumed={onResumed} />
        )}
        <Button
          size="sm"
          variant="ghost"
          aria-expanded={side}
          data-testid="toggle-side"
          onClick={() => {
            setSide(!side);
          }}
        >
          {side ? <ChevronDown /> : <ChevronRight />}
          阶段与请求
        </Button>
      </div>
      {(driver.isError || stopping.isError) && (
        <p role="alert" className="text-sm text-destructive">
          {(driver.error ?? stopping.error)?.message}
        </p>
      )}
      <Notices live={data} />
      <div
        className={side ? 'grid min-w-0 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]' : 'flex'}
      >
        {data.process === null ? (
          // 从本机导入、还没有运行过（Contracts 14.5）：显示这个 session 的对话与 resume 按钮
          <div
            className="flex min-w-0 flex-1 flex-col gap-3 rounded-md border p-4"
            data-testid="live-idle"
          >
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">
                这个 session 还没有在交互区运行过，resume 后在这里接着对话。
              </span>
              <ResumeButton sessionId={data.claudeSessionId} onResumed={onResumed} />
            </div>
            <SessionConversation
              sessionId={data.claudeSessionId}
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
          <div className="max-h-[48rem] min-w-0 overflow-y-auto rounded-md border p-3">
            <SessionSide sessionId={data.claudeSessionId} />
          </div>
        )}
      </div>
    </div>
  );
}

function TabLabel({ liveId }: { liveId: string }) {
  const live = useQuery(liveQuery(liveId));
  return live.data === undefined ? (
    <>{liveId}</>
  ) : (
    <LiveTitle liveId={liveId} title={live.data.title} className="truncate" />
  );
}

// 交互区（Contracts 14.3）：左侧列表，右侧每个打开的 session 一个标签页
export function LivePage() {
  useLiveSessionEvents();
  useSessionEvents();
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const open = (params.get('tabs') ?? '').split(',').filter((id) => id !== '');
  const active = params.get('open') ?? open.at(-1) ?? null;
  const tabs = active !== null && !open.includes(active) ? [...open, active] : open;
  const update = (nextTabs: string[], nextActive: string | null) => {
    setParams(
      () => {
        const next = new URLSearchParams();
        if (nextTabs.length > 0) next.set('tabs', nextTabs.join(','));
        if (nextActive !== null) next.set('open', nextActive);
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">交互</h1>
        <Button
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
      <div className="grid min-w-0 gap-4 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="flex min-w-0 flex-col gap-2">
          <ImportSessionsButton
            onImported={(items) => {
              const last = items.at(-1);
              if (last !== undefined) openTab(last.id);
            }}
          />
          <LiveList onOpen={openTab} active={active} />
        </aside>
        <section className="flex min-w-0 flex-col gap-3">
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
                <LivePanel
                  key={active}
                  liveId={active}
                  onResumed={(live) => {
                    openTab(live.id);
                  }}
                />
              )}
            </>
          )}
        </section>
      </div>
    </div>
  );
}
