import { Icon } from '@iconify/react';
import vscodeIcon from '@iconify-icons/logos/visual-studio-code';
import { Button } from '@/components/ui/button';
import {
  LOCAL_SERVER_ID,
  progressText,
  shortProgressText,
  useVscodeServers,
  vscodeOpenPath,
} from '@/lib/vscode-api';

// The VS Code logo comes from SVG Logos (Gil Barbara, CC0-1.0, @iconify-icons/logos)
export function VscodeLogo({ className }: { className?: string }) {
  return <Icon icon={vscodeIcon} className={className} aria-hidden />;
}

// "Open in VS Code" in the toolbar (Contracts 32.4): opens the new tab on click (opening it later
// would be blocked by the browser), and that page switches to VS Code once ready; while this machine's
// server is still downloading or starting, progress shows beside the button, and on failure the raw error
export function OpenInVscode({
  liveId,
  serverId = LOCAL_SERVER_ID,
}: {
  liveId: string;
  serverId?: string;
}) {
  const servers = useVscodeServers();
  const server = servers.data?.find((s) => s.id === serverId);
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        title="Open in VS Code"
        aria-label="Open in VS Code"
        data-testid="open-vscode"
        onClick={() => {
          window.open(vscodeOpenPath(liveId), '_blank');
        }}
      >
        <VscodeLogo />
      </Button>
      {server?.status === 'preparing' && (
        <span
          className="text-xs whitespace-nowrap text-muted-foreground"
          role="status"
          title={progressText(server)}
          data-testid="vscode-progress"
        >
          {shortProgressText(server)}
        </span>
      )}
      {server?.status === 'failed' && (
        <span
          role="alert"
          className="max-w-40 truncate text-xs text-destructive"
          title={server.error ?? undefined}
          data-testid="vscode-error"
        >
          VS Code didn't start
        </span>
      )}
    </span>
  );
}
