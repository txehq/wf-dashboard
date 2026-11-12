import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Eye, MoreHorizontal, Trash2, X } from 'lucide-react';
import { DropdownMenu, Dialog } from 'radix-ui';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { deleteLive, hideLive, type LiveSummary, unhideLive } from '@/lib/live-api';

// Close, restore and delete (Contracts 14.5): an item with a running process can't be closed or
// deleted until the process is stopped

const stopFirst = 'Running: stop the process first';

// The "×" on a list item: only hides it from the workspace, no confirmation needed
export function HideButton({ live, onHidden }: { live: LiveSummary; onHidden: () => void }) {
  const client = useQueryClient();
  const hiding = useMutation({
    mutationFn: () => hideLive(live.id),
    onSuccess: async () => {
      onHidden();
      await client.invalidateQueries({ queryKey: ['live'] });
    },
  });
  const running = live.status === 'running';
  return (
    <button
      type="button"
      aria-label="Close item"
      title={running ? stopFirst : 'Close (hides it from the workspace; you can restore it)'}
      data-testid="live-hide"
      disabled={running || hiding.isPending}
      className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40"
      onClick={(event) => {
        event.stopPropagation();
        hiding.mutate();
      }}
    >
      <X className="size-3.5" />
    </button>
  );
}

// "Restore" for a closed item
export function UnhideButton({ live }: { live: LiveSummary }) {
  const client = useQueryClient();
  const showing = useMutation({
    mutationFn: () => unhideLive(live.id),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['live'] });
    },
  });
  return (
    <Button
      size="sm"
      variant="outline"
      className="h-7 px-2 text-xs"
      data-testid="live-unhide"
      disabled={showing.isPending}
      onClick={(event) => {
        event.stopPropagation();
        showing.mutate();
      }}
    >
      <Eye />
      Restore
    </Button>
  );
}

// Delete confirmation: lists what will and won't be deleted; deleting requires typing the item's name
function DeleteDialog({
  live,
  open,
  onOpenChange,
  onDeleted,
}: {
  live: LiveSummary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
}) {
  const client = useQueryClient();
  const [typed, setTyped] = useState('');
  const deleting = useMutation({
    mutationFn: () => deleteLive(live.id, typed),
    onSuccess: async () => {
      onOpenChange(false);
      onDeleted();
      await client.invalidateQueries({ queryKey: ['live'] });
      await client.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) setTyped('');
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content
          className="fixed top-1/2 left-1/2 z-50 flex w-[34rem] max-w-[90vw] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 rounded-lg border bg-background p-5 shadow-lg"
          data-testid="delete-dialog"
          onClick={(event) => {
            event.stopPropagation();
          }}
        >
          <Dialog.Title className="text-base font-semibold">Delete item</Dialog.Title>
          <Dialog.Description asChild>
            <div className="flex flex-col gap-2 text-sm">
              <p>Will be deleted:</p>
              <ul className="list-disc pl-5">
                <li>The interaction item "{live.title}", its process and event records</li>
                <li>
                  <code className="text-xs break-all">data/live/{live.id}/</code>: terminal output,
                  hooks.json, the isolated environment's workspace
                </li>
                {live.purpose === 'agent' && <li>Deploy records started by this session</li>}
              </ul>
              <p>Won't be deleted:</p>
              {live.purpose === 'agent' ? (
                // Magi Agent sessions (Contracts 23.1): the session file lives in the user's own config
                // directory or the variant's config directory
                <ul
                  className="list-disc pl-5 text-muted-foreground"
                  data-testid="delete-agent-files"
                >
                  <li>
                    The session file on disk (
                    {live.engine === 'codex'
                      ? 'under ~/.codex'
                      : live.agentConfig === 'local'
                        ? 'under ~/.claude'
                        : `in the config directory of variant ${live.agentConfigName ?? ''}`}
                    ) and its record in Sessions
                  </li>
                  <li>The worktree and the magi-agent branch</li>
                </ul>
              ) : (
                <ul className="list-disc pl-5 text-muted-foreground">
                  <li>
                    The session itself (Claude Code's jsonl and copies, its record in Sessions)
                  </li>
                  <li>GitHub repos and Linear tickets (handle these yourself)</li>
                </ul>
              )}
            </div>
          </Dialog.Description>
          <label className="flex flex-col gap-1.5 text-sm">
            <span>
              Type the item's name to confirm: <span className="font-medium">{live.title}</span>
            </span>
            <Input
              aria-label="Type the name to confirm deletion"
              data-testid="delete-confirm-input"
              value={typed}
              onChange={(event) => {
                setTyped(event.target.value);
              }}
            />
          </label>
          {deleting.isError && (
            <p role="alert" className="text-sm text-destructive">
              {deleting.error.message}
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="outline">Cancel</Button>
            </Dialog.Close>
            <Button
              variant="destructive"
              data-testid="delete-confirm"
              disabled={typed !== live.title || deleting.isPending}
              onClick={() => {
                deleting.mutate();
              }}
            >
              <Trash2 />
              {deleting.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// Each item's menu: "Delete"
export function ItemMenu({ live, onDeleted }: { live: LiveSummary; onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const running = live.status === 'running';
  return (
    <>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="Item menu"
            data-testid="live-menu"
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            className="z-50 min-w-36 rounded-md border bg-background p-1 shadow-md"
          >
            <DropdownMenu.Item
              data-testid="live-delete"
              disabled={running}
              title={running ? stopFirst : undefined}
              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-destructive outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-40 data-[highlighted]:bg-muted"
              onSelect={() => {
                setConfirming(true);
              }}
            >
              <Trash2 className="size-3.5" />
              Delete…
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      <DeleteDialog
        live={live}
        open={confirming}
        onOpenChange={setConfirming}
        onDeleted={onDeleted}
      />
    </>
  );
}
