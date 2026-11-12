import { useMutation } from '@tanstack/react-query';
import { Square } from 'lucide-react';
import { VscodeLogo } from '@/components/live/open-in-vscode';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import { progressText, stopVscodeServer, useVscodeServers } from '@/lib/vscode-api';
import type { VscodeServerView } from '@/lib/vscode-api';

// The "VS Code servers" section in Settings (Contracts 32.4): servers running on this machine and each host, which can be stopped
export function VscodeServers() {
  const servers = useVscodeServers();
  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4" data-testid="vscode-servers">
      <div className="flex items-center gap-3">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <VscodeLogo className="size-4" />
          VS Code servers
        </h2>
        <p className="text-sm text-muted-foreground">
          One per machine, shared by all items; servers on SSH hosts keep running after the
          dashboard restarts.
        </p>
      </div>
      {servers.isError && (
        <p role="alert" className="text-sm text-destructive">
          {servers.error.message}
        </p>
      )}
      {servers.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No servers running. One starts when you click the VS Code icon in a Live item's toolbar.
        </p>
      )}
      {servers.data !== undefined && servers.data.length > 0 && (
        <ul aria-label="VS Code servers" className="flex flex-col divide-y">
          {servers.data.map((s) => (
            <ServerRow key={s.id} server={s} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ServerRow({ server }: { server: VscodeServerView }) {
  const stop = useMutation({ mutationFn: () => stopVscodeServer(server.id) });
  // Failed to start or unreachable: show the message; the button only clears this record
  const broken = server.status === 'failed' || server.status === 'unreachable';
  return (
    <li
      className="flex flex-col gap-1 py-3 text-sm"
      data-testid="vscode-server"
      data-server={server.id}
      data-status={server.status}
    >
      <div className="flex items-center gap-3">
        <span className="font-medium">{server.machine}</span>
        <span className={broken ? 'text-destructive' : 'text-muted-foreground'}>
          {progressText(server)}
        </span>
        {server.version !== null && (
          <span className="text-xs text-muted-foreground">{server.version}</span>
        )}
        {server.port !== null && (
          <span className="font-mono text-xs text-muted-foreground">127.0.0.1:{server.port}</span>
        )}
        {server.startedAt !== null && (
          <span className="text-xs text-muted-foreground">
            Started {formatDateTime(server.startedAt)}
          </span>
        )}
        {server.status !== 'preparing' && (
          <Button
            size="sm"
            variant="outline"
            className="ml-auto"
            disabled={stop.isPending}
            data-testid="vscode-server-stop"
            onClick={() => {
              stop.mutate();
            }}
          >
            <Square />
            {broken ? 'Clear' : 'Stop'}
          </Button>
        )}
      </div>
      {broken && (
        <pre className="max-h-40 overflow-auto text-xs whitespace-pre-wrap text-destructive">
          {server.error}
        </pre>
      )}
      {stop.isError && (
        <p role="alert" className="text-xs text-destructive">
          {stop.error.message}
        </p>
      )}
    </li>
  );
}
