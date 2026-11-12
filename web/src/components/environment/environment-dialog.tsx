import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, ChevronRight, CircleCheck, CircleX, RefreshCw, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Dialog } from 'radix-ui';
import { Button } from '@/components/ui/button';
import {
  type EnvironmentCheck,
  refreshEnvironment,
  useEnvironment,
} from '@/components/environment/environment-api';

function CheckRow({ check }: { check: EnvironmentCheck }) {
  // Failed checks start expanded so the cause and fix are visible
  const [open, setOpen] = useState(!check.ok);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <li className="border-b last:border-b-0" data-testid={`env-check-${check.id}`}>
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-1 py-2 text-left text-sm hover:bg-muted/60"
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Chevron className="size-4 shrink-0 text-muted-foreground" />
        {check.ok ? (
          <CircleCheck className="size-4 shrink-0 text-status-good" aria-label="Passed" />
        ) : (
          <CircleX className="size-4 shrink-0 text-destructive" aria-label="Failed" />
        )}
        <span className="min-w-0 truncate">{check.label}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-2 pb-3 pl-7 text-xs">
          <pre
            className="max-h-48 overflow-auto rounded bg-muted px-2 py-1.5 whitespace-pre-wrap break-all"
            data-testid="env-detail"
          >
            {check.detail === '' ? '(no output)' : check.detail}
          </pre>
          {!check.ok && (
            <div data-testid="env-fix">
              <span className="font-medium">Fix: </span>
              <code className="break-all whitespace-pre-wrap">{check.fix}</code>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

// Environment checklist: failed checks first; "Recheck" bypasses the server's 10-minute cache
export function EnvironmentDialog({ trigger }: { trigger: ReactNode }) {
  const client = useQueryClient();
  const { query, queryKey } = useEnvironment();
  const refresh = useMutation({
    mutationFn: refreshEnvironment,
    onSuccess: (report) => {
      client.setQueryData(queryKey, report);
    },
  });
  const checks = [...(query.data?.checks ?? [])].sort((a, b) => Number(a.ok) - Number(b.ok));
  const checking = query.isPending || refresh.isPending;

  return (
    <Dialog.Root>
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/30" />
        <Dialog.Content
          className="fixed top-0 right-0 z-50 flex h-svh w-[min(640px,100vw)] flex-col gap-4 border-l bg-background p-6 shadow-lg"
          data-testid="environment-dialog"
        >
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <Dialog.Title className="text-lg font-semibold">Environment</Dialog.Title>
              <Dialog.Description className="text-xs text-muted-foreground">
                {query.data === undefined
                  ? 'Checking what this machine needs to run evaluations…'
                  : `Checked ${new Date(query.data.checkedAt).toLocaleString('en-US', { hour12: false })}. Results are kept for 10 minutes.`}
              </Dialog.Description>
            </div>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={checking}
                onClick={() => {
                  refresh.mutate();
                }}
              >
                <RefreshCw className={checking ? 'animate-spin' : ''} />
                {checking ? 'Checking…' : 'Recheck'}
              </Button>
              <Dialog.Close asChild>
                <Button variant="ghost" size="icon" aria-label="Close">
                  <X />
                </Button>
              </Dialog.Close>
            </div>
          </div>
          {query.isError && <p className="text-sm text-destructive">{query.error.message}</p>}
          {refresh.isError && <p className="text-sm text-destructive">{refresh.error.message}</p>}
          <ul className="flex-1 overflow-auto" data-testid="environment-checks">
            {checks.map((check) => (
              <CheckRow key={`${check.id}-${String(query.data?.checkedAt)}`} check={check} />
            ))}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
