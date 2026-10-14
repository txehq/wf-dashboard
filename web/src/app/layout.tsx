import { useQuery } from '@tanstack/react-query';
import { Outlet } from 'react-router';
import { EnvironmentStatus } from '@/components/environment/environment-status';
import { MainNav } from '@/components/main-nav';
import { MagiAgentButton } from '@/components/magi-agent-button';
import { healthQuery } from '@/lib/api';
import { useLiveConnection, useLiveStatus } from '@/lib/live-events';
import { useMagiEvents } from '@/lib/magi-api';

function ServerStatus() {
  const health = useQuery(healthQuery);
  const label = health.isPending ? '连接中' : health.isError ? '未连接' : health.data.status;
  return (
    <p className="px-5 text-xs text-muted-foreground" data-testid="server-status">
      服务端：{label}
    </p>
  );
}

// 实时连接断开时提示：页面上的状态可能已经过时；重连后自动刷新
function LiveStatusBanner() {
  const status = useLiveStatus();
  if (status !== 'lost') return null;
  return (
    <div
      role="status"
      data-testid="live-lost"
      className="mb-4 rounded-md border border-warning-border bg-warning px-3 py-2 text-sm text-warning-foreground"
    >
      实时连接已断开，正在重连；重连后页面自动刷新。
    </div>
  );
}

export function Layout() {
  useLiveConnection();
  useMagiEvents();
  return (
    <div className="flex min-h-svh">
      {/* 最上面一行：名字与 Magi Agent 按钮（Contracts 23.6）；宽度放得下两者 */}
      <aside className="flex w-60 shrink-0 flex-col gap-4 border-r bg-muted/40 py-4">
        <div className="flex items-center justify-between gap-1 pr-2 pl-5">
          <span className="text-sm font-semibold whitespace-nowrap">Magi Dashboard</span>
          <MagiAgentButton />
        </div>
        <MainNav />
        <div className="mt-auto flex flex-col gap-2">
          <EnvironmentStatus />
          <ServerStatus />
        </div>
      </aside>
      {/* min-w-0：页面宽度不被内容中不换行的长文本撑开 */}
      <main className="min-w-0 flex-1 p-8">
        <LiveStatusBanner />
        <Outlet />
      </main>
    </div>
  );
}
