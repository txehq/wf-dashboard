import { useQuery } from '@tanstack/react-query';
import { Settings } from 'lucide-react';
import { Link, Outlet, useLocation } from 'react-router';
import { EnvironmentStatus } from '@/components/environment/environment-status';
import { MainNav } from '@/components/main-nav';
import { MagiAgentButton } from '@/components/magi-agent-button';
import { Button } from '@/components/ui/button';
import { healthQuery } from '@/lib/api';
import { useInstall } from '@/lib/install-api';
import { useLiveConnection, useLiveStatus } from '@/lib/live-events';
import { useMagiEvents } from '@/lib/magi-api';

function ServerStatus() {
  const health = useQuery(healthQuery);
  const install = useInstall();
  const label = health.isPending
    ? 'Connecting'
    : health.isError
      ? 'Disconnected'
      : health.data.status;
  return (
    <p className="px-5 text-xs text-muted-foreground" data-testid="server-status">
      Server: {label}
      {install.data?.installed === true && (
        <span data-testid="installed-version" title={`Installed in ${install.data.root}`}>
          {' '}
          · v{install.data.version}
        </span>
      )}
    </p>
  );
}

// An installed package's self-update (Contracts 39.4): shown only while it is doing or waiting for something, or failed
function UpdateStatus() {
  const install = useInstall();
  if (install.data?.installed !== true) return null;
  const { update } = install.data;
  if (update.error !== null) {
    return (
      <details className="px-5 text-xs text-destructive" data-testid="update-error">
        <summary className="cursor-pointer">
          Update failed, still on v{install.data.version}
        </summary>
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-muted p-2 font-mono whitespace-pre-wrap text-foreground">
          {update.error}
        </pre>
      </details>
    );
  }
  if (update.pending !== null && update.waitingFor.length > 0) {
    return (
      <p
        className="px-5 text-xs text-muted-foreground"
        data-testid="update-waiting"
        title={update.waitingFor.join('\n')}
      >
        v{update.pending} installs when {update.waitingFor.length} running{' '}
        {update.waitingFor.length === 1 ? 'item finishes' : 'items finish'}
      </p>
    );
  }
  if (update.step !== null) {
    const step = {
      checking: 'Checking for updates…',
      downloading: `Downloading v${update.latest ?? ''}…`,
      verifying: `Verifying v${update.latest ?? ''}…`,
    }[update.step];
    return (
      <p className="px-5 text-xs text-muted-foreground" data-testid="update-step">
        {step}
      </p>
    );
  }
  return null;
}

// Shown while the live connection is down: states on the page may be stale; the page refreshes on reconnect
function LiveStatusBanner() {
  const status = useLiveStatus();
  if (status !== 'lost') return null;
  return (
    <div
      role="status"
      data-testid="live-lost"
      className="mb-4 rounded-md border border-warning-border bg-warning px-3 py-2 text-sm text-warning-foreground"
    >
      Live connection lost. Reconnecting; the page will refresh when it is back.
    </div>
  );
}

// Global settings page (/settings): a gear icon, highlighted while on the settings page
function SettingsLink() {
  const { pathname } = useLocation();
  const current = pathname === '/settings';
  return (
    <Button
      asChild
      size="icon"
      variant={current ? 'secondary' : 'ghost'}
      className="size-8"
      title="Settings"
    >
      <Link to="/settings" aria-label="Settings" aria-current={current ? 'page' : undefined}>
        <Settings />
      </Link>
    </Button>
  );
}

export function Layout() {
  useLiveConnection();
  useMagiEvents();
  return (
    <div className="flex min-h-svh">
      {/* Top row: the name, the Magi Agent robot button (Contracts 23.6) and the settings gear at the far right */}
      <aside className="flex w-60 shrink-0 flex-col gap-4 border-r bg-muted/40 py-4">
        <div className="flex items-center justify-between gap-1 pr-2 pl-5">
          <span className="text-sm font-semibold whitespace-nowrap">Magi Dashboard</span>
          <span className="flex items-center gap-0.5">
            <MagiAgentButton />
            <SettingsLink />
          </span>
        </div>
        <MainNav />
        <div className="mt-auto flex flex-col gap-2">
          <EnvironmentStatus />
          <ServerStatus />
          <UpdateStatus />
        </div>
      </aside>
      {/* min-w-0: long unbreakable text in the content does not widen the page */}
      <main className="min-w-0 flex-1 p-8">
        <LiveStatusBanner />
        <Outlet />
      </main>
    </div>
  );
}
