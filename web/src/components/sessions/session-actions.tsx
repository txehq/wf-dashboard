import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, Eraser, Trash2, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { actionPlanQuery, runSessionAction, type SessionAction } from '@/lib/sessions-api';
import type { SelectedSession } from '@/lib/session-selection';

// Clear, delete, archive and restore in the table's multi-select and the detail header (Contracts 25.1, 25.3).
// Clear only removes sessions from the manage table (files on disk stay; they can be imported again above) and
// runs directly; Claude Code also has delete, Codex also has archive (restore for archived ones) and delete.
// Delete first shows a confirmation dialog (the sessions to delete and every file path); archive and restore
// run directly; refusals and failures are shown as returned
export type ActionTarget = SelectedSession;

async function refresh(client: ReturnType<typeof useQueryClient>) {
  await Promise.all([
    client.invalidateQueries({ queryKey: ['sessions'] }),
    client.invalidateQueries({ queryKey: ['session-import'] }),
    client.invalidateQueries({ queryKey: ['session'] }),
    client.invalidateQueries({ queryKey: ['live'] }),
  ]);
}

export function SessionActionButtons({
  targets,
  onDone,
}: {
  targets: ActionTarget[];
  // After success (clear the selection, or go back to the list from the detail page)
  onDone: (action: SessionAction) => void;
}) {
  const client = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const ids = targets.map((t) => t.id);
  const codex = targets.length > 0 && targets.every((t) => t.engine === 'codex');
  const archived = targets.filter((t) => t.archived).length;
  const move = useMutation({
    mutationFn: (action: 'clear' | 'archive' | 'unarchive') => runSessionAction(action, ids),
    onSuccess: async (_plan, action) => {
      await refresh(client);
      onDone(action);
    },
    onError: async () => {
      // On partial success (earlier ones already archived) the list updates too
      await refresh(client);
    },
  });
  const pending = move.isPending ? move.variables : null;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        data-testid="session-clear"
        title="Remove from the manage table. Files on disk stay, and you can import them again above."
        disabled={targets.length === 0 || move.isPending}
        onClick={() => {
          move.mutate('clear');
        }}
      >
        <Eraser />
        {pending === 'clear' ? 'Clearing…' : 'Clear'}
      </Button>
      {codex && archived === 0 && (
        <Button
          size="sm"
          variant="outline"
          data-testid="session-archive"
          disabled={move.isPending}
          onClick={() => {
            move.mutate('archive');
          }}
        >
          <Archive />
          {pending === 'archive' ? 'Archiving…' : 'Archive'}
        </Button>
      )}
      {codex && archived === targets.length && (
        <Button
          size="sm"
          variant="outline"
          data-testid="session-unarchive"
          disabled={move.isPending}
          onClick={() => {
            move.mutate('unarchive');
          }}
        >
          <ArchiveRestore />
          {pending === 'unarchive' ? 'Restoring…' : 'Restore'}
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        className="text-destructive"
        data-testid="session-delete"
        disabled={targets.length === 0}
        onClick={() => {
          setDeleting(true);
        }}
      >
        <Trash2 />
        Delete
      </Button>
      {move.isError && (
        <p
          role="alert"
          className="basis-full text-sm whitespace-pre-wrap text-destructive"
          data-testid="session-action-error"
        >
          {move.error.message}
        </p>
      )}
      {deleting && (
        <DeleteSessionsDialog
          ids={ids}
          onClose={() => {
            setDeleting(false);
          }}
          onDeleted={() => {
            setDeleting(false);
            onDone('delete');
          }}
        />
      )}
    </>
  );
}

function DeleteSessionsDialog({
  ids,
  onClose,
  onDeleted,
}: {
  ids: string[];
  onClose: () => void;
  onDeleted: () => void;
}) {
  const client = useQueryClient();
  const plan = useQuery({
    ...actionPlanQuery('delete', ids),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const remove = useMutation({
    mutationFn: () => runSessionAction('delete', ids),
    onSuccess: async () => {
      await refresh(client);
      onDeleted();
    },
    onError: async () => {
      await refresh(client);
    },
  });
  const p = plan.data;
  const blocked = p !== undefined && p.blockers.length > 0;
  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/30" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 z-[60] flex max-h-[90vh] w-[min(52rem,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border bg-background p-4 shadow-lg"
          data-testid="session-delete-dialog"
          aria-describedby={undefined}
        >
          <div className="flex items-center gap-3">
            <Dialog.Title className="text-base font-semibold">
              Permanently delete {ids.length} {ids.length === 1 ? 'session' : 'sessions'}
            </Dialog.Title>
            <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
              <X />
              Cancel
            </Button>
          </div>
          {plan.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
          {plan.isError && (
            <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
              {plan.error.message}
            </p>
          )}
          {p !== undefined && (
            <div className="flex min-h-0 flex-col gap-4 overflow-auto pr-1">
              {blocked && (
                <Alert variant="destructive" data-testid="session-delete-blockers">
                  <AlertTitle>Cannot delete right now</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc pl-4">
                      {p.blockers.map((b) => (
                        <li key={`${b.sessionId}:${b.label}`}>{b.label}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
              <p className="text-sm">
                The dashboard records (requests, stages, bindings) are deleted together with the
                files below on disk. This cannot be undone.
              </p>
              <ul className="flex flex-col gap-3" data-testid="session-delete-list">
                {p.sessions.map((s) => (
                  <li key={s.id} className="flex flex-col gap-1" data-session={s.id}>
                    <span className="text-sm font-medium">
                      {s.title ?? '(no user message)'}
                      <span className="ml-2 font-mono text-xs text-muted-foreground">
                        {s.id.slice(0, 8)}
                      </span>
                    </span>
                    {s.engine === 'codex' && (
                      <span className="text-xs text-muted-foreground">
                        Permanently deleted by codex delete
                      </span>
                    )}
                    <ul className="max-h-40 overflow-auto rounded-md bg-muted px-2 py-1 font-mono text-xs">
                      {s.files.map((f) => (
                        <li key={f} className="truncate" title={f}>
                          {f}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
              {p.liveItems.length > 0 && (
                <p className="text-sm" data-testid="session-delete-live">
                  Their Live items are deleted along with their directories:{' '}
                  {p.liveItems.map((i) => i.title).join(', ')}
                </p>
              )}
            </div>
          )}
          {remove.isError && (
            <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
              {remove.error.message}
            </p>
          )}
          <div className="flex justify-end gap-2 border-t pt-3">
            <Button size="sm" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              data-testid="session-delete-confirm"
              disabled={p === undefined || blocked || remove.isPending}
              onClick={() => {
                remove.mutate();
              }}
            >
              <Trash2 />
              {remove.isPending ? 'Deleting…' : 'Permanently delete'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
