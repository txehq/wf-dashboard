import { useQuery } from '@tanstack/react-query';
import { Columns2, GitBranch, History, ListChecks, Play } from 'lucide-react';
import { NavLink, Outlet } from 'react-router';
import { EnvironmentStatus } from '@/components/environment/environment-status';
import { Button } from '@/components/ui/button';
import { healthQuery } from '@/lib/api';
import { useLiveConnection, useLiveStatus } from '@/lib/live-events';

const navItems = [
  { to: '/sessions', label: 'Sessions', icon: History },
  { to: '/runs', label: 'Runs', icon: Play },
  { to: '/variants', label: 'Variants', icon: GitBranch },
  { to: '/tasks', label: 'Tasks', icon: ListChecks },
  { to: '/compare', label: 'Compare', icon: Columns2 },
] as const;

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
      className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
    >
      实时连接已断开，正在重连；重连后页面自动刷新。
    </div>
  );
}

export function Layout() {
  useLiveConnection();
  return (
    <div className="flex min-h-svh">
      <aside className="flex w-56 shrink-0 flex-col gap-4 border-r bg-muted/40 py-4">
        <div className="px-5 text-sm font-semibold">Magi Dashboard</div>
        <nav aria-label="主导航" className="flex flex-col gap-1 px-2">
          {navItems.map(({ to, label, icon: Icon }) => (
            <Button
              key={to}
              asChild
              variant="ghost"
              className="w-full justify-start aria-[current=page]:bg-background aria-[current=page]:font-semibold aria-[current=page]:shadow-xs"
            >
              <NavLink to={to}>
                <Icon />
                {label}
              </NavLink>
            </Button>
          ))}
        </nav>
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
