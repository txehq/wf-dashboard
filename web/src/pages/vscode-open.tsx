import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { VscodeLogo } from '@/components/live/open-in-vscode';
import { must } from '@/lib/must';
import {
  listVscodeServers,
  openVscode,
  progressText,
  type VscodeServerView,
} from '@/lib/vscode-api';

const POLL_MS = 1_000;
// Ten years
const LOCALE_COOKIE_MAX_AGE_S = 10 * 365 * 24 * 60 * 60;

// The "Open in VS Code" tab (Contracts 32.4): once the server is ready this page is replaced by the VS Code address;
// while preparing it reads progress every second, and shows the error text on failure
export function VscodeOpenPage() {
  const liveId = must(useParams().liveId, 'liveId in the address');
  const [progress, setProgress] = useState<VscodeServerView | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    document.title = 'VS Code';
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fail = (message: string) => {
      if (!stopped) setError(message);
    };
    const poll = async (serverId: string) => {
      const servers = await listVscodeServers();
      const server = servers.find((s) => s.id === serverId);
      if (stopped) return;
      if (server === undefined) {
        fail('The VS Code server has stopped. Close this tab and open it again.');
        return;
      }
      if (server.status === 'failed') {
        fail(server.error ?? 'Failed to start');
        return;
      }
      if (server.status === 'running') {
        await open();
        return;
      }
      setProgress(server);
      timer = setTimeout(() => {
        void poll(serverId).then(undefined, (e: unknown) => {
          fail(String(e));
        });
      }, POLL_MS);
    };
    const open = async () => {
      const result = await openVscode(liveId);
      if (stopped) return;
      if ('url' in result) {
        // VS Code's page takes its language from the vscode.nls.locale cookie before the browser's language
        // (Contracts 36.1). Cookies on 127.0.0.1 are shared by every port, so set here, it reaches the VS Code address
        document.cookie = `vscode.nls.locale=en;path=/;max-age=${String(LOCALE_COOKIE_MAX_AGE_S)}`;
        window.location.replace(result.url);
        return;
      }
      setProgress(result.progress);
      await poll(result.progress.id);
    };
    void open().then(undefined, (e: unknown) => {
      fail(e instanceof Error ? e.message : String(e));
    });
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [liveId]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-background p-6 text-foreground">
      <div className="flex max-w-xl flex-col items-center gap-3 text-center">
        <VscodeLogo className="size-12" />
        {error === null ? (
          <>
            <h1 className="text-lg font-semibold">Opening VS Code</h1>
            <p
              className="text-sm text-muted-foreground"
              role="status"
              data-testid="vscode-progress"
            >
              {progress === null ? 'Connecting' : progressText(progress)}
            </p>
          </>
        ) : (
          <>
            <h1 className="text-lg font-semibold">VS Code failed to start</h1>
            <pre
              role="alert"
              className="max-h-80 max-w-full overflow-auto rounded-md border p-3 text-left text-xs whitespace-pre-wrap text-destructive"
              data-testid="vscode-error"
            >
              {error}
            </pre>
          </>
        )}
      </div>
    </main>
  );
}
