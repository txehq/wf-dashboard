import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronUp, Folder, FolderOpen, FolderPlus } from 'lucide-react';
import { childPath, existsMessage, folderNameProblem } from '@wf-dashboard/server/dirs/views';
import { Dialog } from 'radix-ui';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { createDir, type DirSource, dirsQuery } from '@/lib/dirs-api';
import { HttpError } from '@/lib/http';

// Browse directories and pick a working directory (Contracts 31.3, 34.1): lists subdirectories level by level and can create a folder in the current one; shared by SSH hosts and this machine
export function DirBrowser({
  source,
  title,
  start,
  onPick,
}: {
  source: DirSource;
  title: string;
  // Directory shown on open; HOME when empty
  start: string;
  onPick: (dir: string) => void;
}) {
  const client = useQueryClient();
  const [open, setOpen] = useState(false);
  const [dir, setDir] = useState(start);
  // Name of the new folder; null when not creating one
  const [naming, setNaming] = useState<string | null>(null);
  const dirs = useQuery({ ...dirsQuery(source, dir), enabled: open });
  const creating = useMutation({
    mutationFn: ({ parent, name }: { parent: string; name: string }) =>
      createDir(source, parent, name),
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: dirsQuery(source, dir).queryKey });
      // Enter the new folder and pick it as the working directory
      setDir(created);
      setNaming(null);
      onPick(created);
      setOpen(false);
    },
  });
  const go = (next: string) => {
    setDir(next);
    setNaming(null);
    creating.reset();
  };

  const listed = dirs.data;
  const name = naming ?? '';
  // Reason under the input: first from the name rules and the listed subdirectories, after submitting the server's reason (already exists, mkdir's message)
  const problem =
    naming === null || listed === undefined
      ? null
      : name === ''
        ? null
        : (folderNameProblem(name) ??
          (listed.dirs.includes(name) ? existsMessage(childPath(listed.path, name)) : null));
  const serverError = creating.isError
    ? creating.error instanceof HttpError && creating.error.reason !== ''
      ? creating.error.reason
      : creating.error.message
    : null;
  const submit = () => {
    if (listed === undefined || name === '' || problem !== null || creating.isPending) return;
    creating.mutate({ parent: listed.path, name });
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (next) go(start);
        setOpen(next);
      }}
    >
      <Dialog.Trigger asChild>
        <Button type="button" variant="outline" data-testid="browse-dirs">
          <FolderOpen />
          Browse
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 z-50 flex max-h-[80vh] w-[min(40rem,92vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border bg-background p-4 shadow-lg"
          data-testid="dir-browser"
          aria-describedby={undefined}
          // While creating a folder, Esc cancels only the new folder
          onEscapeKeyDown={(event) => {
            if (naming === null) return;
            event.preventDefault();
            setNaming(null);
            creating.reset();
          }}
        >
          <Dialog.Title className="text-sm font-semibold">{title}</Dialog.Title>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              aria-label="Parent directory"
              title="Parent directory"
              disabled={listed?.parent == null}
              onClick={() => {
                if (listed?.parent != null) go(listed.parent);
              }}
            >
              <ChevronUp />
            </Button>
            {/* A long path is cut at the start, keeping the current directory's name */}
            <span
              className="min-w-0 flex-1 truncate text-left font-mono text-xs [direction:rtl]"
              title={listed?.path ?? dir}
              data-testid="dir-path"
            >
              <bdi dir="ltr">{listed?.path ?? dir}</bdi>
            </span>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={listed === undefined || naming !== null}
              data-testid="new-dir"
              onClick={() => {
                creating.reset();
                setNaming('');
              }}
            >
              <FolderPlus />
              New folder
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={listed === undefined}
              data-testid="pick-dir"
              onClick={() => {
                if (listed === undefined) return;
                onPick(listed.path);
                setOpen(false);
              }}
            >
              Use this directory
            </Button>
          </div>
          <div className="min-h-40 overflow-y-auto rounded-md border">
            {naming !== null && (
              <div className="flex flex-col gap-1 border-b px-3 py-1.5">
                <div className="flex items-center gap-2">
                  <FolderPlus className="size-4 shrink-0 text-muted-foreground" />
                  <input
                    // Typing can start right after clicking "New folder"
                    autoFocus
                    aria-label="New folder name"
                    placeholder="New folder name, Enter to create"
                    data-testid="new-dir-name"
                    aria-invalid={problem !== null || serverError !== null}
                    className="h-7 min-w-0 flex-1 rounded border bg-background px-1.5 text-sm aria-invalid:border-destructive"
                    value={naming}
                    disabled={creating.isPending}
                    onChange={(event) => {
                      creating.reset();
                      setNaming(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Enter') return;
                      event.preventDefault();
                      submit();
                    }}
                  />
                  {creating.isPending && (
                    <span className="text-xs text-muted-foreground">Creating…</span>
                  )}
                </div>
                {(problem ?? serverError) !== null && (
                  <p
                    role="alert"
                    className="pl-6 font-mono text-xs whitespace-pre-wrap text-destructive"
                    data-testid="new-dir-error"
                  >
                    {problem ?? serverError}
                  </p>
                )}
              </div>
            )}
            {dirs.isPending && <p className="p-3 text-sm text-muted-foreground">Loading…</p>}
            {dirs.isError && (
              <p
                role="alert"
                className="p-3 font-mono text-xs whitespace-pre-wrap text-destructive"
              >
                {dirs.error.message}
              </p>
            )}
            {listed?.dirs.length === 0 && naming === null && (
              <p className="p-3 text-sm text-muted-foreground">No subdirectories.</p>
            )}
            <ul>
              {listed?.dirs.map((child) => (
                <li key={child}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-muted"
                    onClick={() => {
                      go(childPath(listed.path, child));
                    }}
                  >
                    <Folder className="size-4 shrink-0 text-muted-foreground" />
                    {child}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
