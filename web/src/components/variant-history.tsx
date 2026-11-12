import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { History, RotateCcw, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useState } from 'react';
import { DiffViewTypeToggle } from '@/components/diff';
import { SourceDiff, SourceDiffSummary } from '@/components/source-diff';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { engineNames } from '@/lib/engine-names';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  type HistoryEntry,
  historyDiffQuery,
  historyQuery,
  isImported,
  request,
  type Variant,
} from '@/pages/variants-api';

const entryLabel = (e: HistoryEntry): string => {
  if (e.kind === 'rename') return `Renamed: ${e.from} → ${e.to}`;
  if (e.kind === 'overwrite') {
    const draft = e.draftEngine === null ? 'draft' : `${engineNames[e.draftEngine]} draft`;
    return `Before overwrite by ${draft} ${e.draftId}${e.analysisId === null ? '' : ` (analysis ${e.analysisId})`}`;
  }
  return `Before restoring #${String(e.restoredEventId)}`;
};

// A variant's history (Contracts 17.4): the src/ kept before each overwrite or restore can be viewed and restored; a rename is one line
export function VariantHistoryButton({ variant }: { variant: Variant }) {
  const history = useQuery(historyQuery(variant.id));
  const [open, setOpen] = useState(false);
  const entries = history.data ?? [];
  if (entries.length === 0) return null;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        data-testid="variant-history"
        title="Content kept before overwrites and restores; view or restore it"
        onClick={() => {
          setOpen(true);
        }}
      >
        <History />
        History ({entries.length})
      </Button>
      {open && (
        <HistoryDialog
          variant={variant}
          entries={entries}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function HistoryDialog({
  variant,
  entries,
  onClose,
}: {
  variant: Variant;
  entries: HistoryEntry[];
  onClose: () => void;
}) {
  const client = useQueryClient();
  const snapshots = entries.filter((e) => e.kind !== 'rename');
  const [selected, setSelected] = useState<number | null>(snapshots.at(-1)?.id ?? null);
  const diff = useQuery({
    ...historyDiffQuery(variant.id, selected ?? 0),
    enabled: selected !== null,
  });
  const restore = useMutation({
    mutationFn: (eventId: number) =>
      request<Variant>('POST', `/api/variants/${variant.id}/history/${String(eventId)}/restore`),
    onSuccess: async () => {
      // Both the file tree and file contents changed
      await client.invalidateQueries({ queryKey: ['variants', variant.id] });
      await client.invalidateQueries({ queryKey: ['variants'], exact: true });
      onClose();
    },
  });
  const blocked = isImported(variant)
    ? 'Imported variants cannot be restored'
    : variant.status === 'frozen'
      ? 'Frozen (used by a batch); read-only'
      : null;
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
          className="fixed inset-x-[3vw] inset-y-[4vh] z-[60] flex flex-col gap-3 rounded-lg border bg-background p-4 shadow-lg"
          data-testid="variant-history-dialog"
          aria-describedby={undefined}
        >
          <div className="flex flex-wrap items-center gap-3">
            <Dialog.Title className="text-base font-semibold">{variant.name} history</Dialog.Title>
            <div className="ml-auto flex items-center gap-2">
              {diff.isSuccess && <SourceDiffSummary files={diff.data} />}
              <DiffViewTypeToggle />
              <Button
                size="sm"
                data-testid="variant-history-restore"
                disabled={selected === null || blocked !== null || restore.isPending}
                title={
                  blocked ??
                  'Restore src to the selected version; the current content is also kept in history'
                }
                onClick={() => {
                  if (selected !== null) restore.mutate(selected);
                }}
              >
                <RotateCcw />
                {restore.isPending ? 'Restoring…' : 'Restore this version'}
              </Button>
              <Button size="sm" variant="ghost" onClick={onClose}>
                <X />
                Close
              </Button>
            </div>
          </div>
          {restore.isError && (
            <Alert variant="destructive">
              <AlertTitle>Restore failed</AlertTitle>
              <AlertDescription className="whitespace-pre-wrap">
                {restore.error.message}
              </AlertDescription>
            </Alert>
          )}
          <div className="flex min-h-0 flex-1 gap-4">
            <ol
              className="flex w-72 shrink-0 flex-col gap-1 overflow-auto"
              data-testid="variant-history-list"
            >
              {[...entries].reverse().map((e) => (
                <li key={e.id}>
                  {e.kind === 'rename' ? (
                    <p className="px-2 py-1.5 text-sm text-muted-foreground">
                      <span className="block text-xs">
                        {formatDateTime(new Date(e.at).toISOString())}
                      </span>
                      {entryLabel(e)}
                    </p>
                  ) : (
                    <button
                      type="button"
                      data-testid="variant-history-entry"
                      className={cn(
                        'w-full rounded-md border px-2 py-1.5 text-left text-sm hover:bg-muted',
                        selected === e.id && 'border-primary bg-muted',
                      )}
                      onClick={() => {
                        setSelected(e.id);
                      }}
                    >
                      <span className="block text-xs text-muted-foreground">
                        {formatDateTime(new Date(e.at).toISOString())}
                      </span>
                      {entryLabel(e)}
                    </button>
                  )}
                </li>
              ))}
            </ol>
            <div className="min-w-0 flex-1 overflow-auto" data-testid="variant-history-diff">
              <p className="mb-2 text-xs text-muted-foreground">
                {selected === null
                  ? 'Only renames; no saved content.'
                  : 'Changes if restored to this version'}
              </p>
              {diff.isError && (
                <pre role="alert" className="text-xs whitespace-pre-wrap text-destructive">
                  {diff.error.message}
                </pre>
              )}
              {diff.isSuccess && (
                <SourceDiff files={diff.data} empty="Same as the current content." />
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
