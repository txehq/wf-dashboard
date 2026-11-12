import { useMutation, useQuery } from '@tanstack/react-query';
import { BookOpen, GitBranch, Link2, SquareKanban } from 'lucide-react';
import { Popover } from 'radix-ui';
import { Link } from 'react-router';
import { HostLabel } from '@/components/ssh/ssh-parts';
import { Button } from '@/components/ui/button';
import { openInFinder } from '@/lib/open-api';
import { type SessionDetail, sessionLinksQuery } from '@/lib/sessions-api';

// Working directory, bound variant and linked items in the Session detail header (Contracts 18.2)

// Working directory: click to open the session's recorded cwd in Finder; if the directory is missing, the
// error is shown as returned
export function WorkspaceLink({ session }: { session: SessionDetail }) {
  const open = useMutation({
    mutationFn: () => openInFinder({ kind: 'session-cwd', id: session.id }),
  });
  if (session.cwd === null) return <span>—</span>;
  // Session from an SSH host (Contracts 31.6): the directory is remote and does not open in Finder
  if (session.host !== null) {
    return (
      <span className="inline-flex flex-wrap items-center gap-2" data-testid="session-workspace">
        <HostLabel label={session.host.label} />
        <span className="font-mono">{session.cwd}</span>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        className="font-mono underline-offset-2 hover:text-foreground hover:underline"
        title="Open in Finder"
        data-testid="session-workspace"
        onClick={() => {
          open.mutate();
        }}
      >
        {session.cwd}
      </button>
      {open.isError && (
        <span role="alert" className="text-destructive">
          {open.error.message}
        </span>
      )}
    </span>
  );
}

export function VariantLink({ session }: { session: SessionDetail }) {
  if (session.variant === null) return <span>Not bound</span>;
  if (session.variant.deleted) {
    return <span data-testid="session-variant-link">{session.variant.name}</span>;
  }
  return (
    <Link
      to={`/variants/${session.variant.id}`}
      className="underline-offset-2 hover:text-foreground hover:underline"
      data-testid="session-variant-link"
    >
      {session.variant.name}
    </Link>
  );
}

// No button when there are no linked items
export function SessionLinksButton({ sessionId }: { sessionId: string }) {
  const links = useQuery(sessionLinksQuery(sessionId));
  if (links.isError) {
    return (
      <span role="alert" className="text-xs text-destructive">
        {links.error.message}
      </span>
    );
  }
  if (links.data === undefined) return null;
  const { github, linear, obsidian } = links.data;
  if (github.length + linear.length + obsidian.length === 0) return null;
  const item = 'flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-muted';
  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <Button variant="outline" size="sm" data-testid="session-links-open">
          <Link2 />
          Linked items
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={6}
          className="z-50 flex w-80 flex-col gap-2 rounded-md border bg-background p-2 shadow-md"
          data-testid="session-links"
        >
          {github.length > 0 && (
            <section className="flex flex-col">
              <h3 className="px-2 pt-1 text-xs text-muted-foreground">GitHub</h3>
              {github.map((g) => (
                <a key={g.url} href={g.url} target="_blank" rel="noreferrer" className={item}>
                  <GitBranch className="size-4 shrink-0" />
                  <span className="truncate font-mono text-xs">{g.label}</span>
                </a>
              ))}
            </section>
          )}
          {linear.length > 0 && (
            <section className="flex flex-col">
              <h3 className="px-2 pt-1 text-xs text-muted-foreground">Linear</h3>
              {linear.map((l) => (
                <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className={item}>
                  <SquareKanban className="size-4 shrink-0" />
                  <span className="truncate font-mono text-xs">{l.label}</span>
                </a>
              ))}
            </section>
          )}
          {obsidian.length > 0 && (
            <section className="flex flex-col">
              <h3 className="px-2 pt-1 text-xs text-muted-foreground">Obsidian</h3>
              {obsidian.map((o) => (
                <a
                  key={o.path}
                  href={`obsidian://open?path=${encodeURIComponent(o.path)}`}
                  title={o.path}
                  className={item}
                >
                  <BookOpen className="size-4 shrink-0" />
                  <span className="truncate text-xs">{o.label}</span>
                </a>
              ))}
            </section>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
