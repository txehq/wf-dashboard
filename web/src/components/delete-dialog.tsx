import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DeletionPlan, SessionsChoice } from '@wf-dashboard/server/deletion/views';
import { Trash2, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { formatNoun } from '@/lib/format';
import { requestJson } from '@/lib/http';
import { variantsQuery } from '@/pages/variants-api';

type Kind = 'variant' | 'workflow';

const base = (kind: Kind, id: string) =>
  `/api/${kind === 'variant' ? 'variants' : 'workflows'}/${encodeURIComponent(id)}`;

// Delete a variant or workflow (Contracts 24.6): the button sits in an existing button group; icon shows only the icon (list rows)
export function DeleteButton({
  kind,
  id,
  name,
  icon = false,
  after,
}: {
  kind: Kind;
  id: string;
  name: string;
  icon?: boolean;
  // Where to go after deleting; stays on the current page when not given
  after?: string;
}) {
  const [open, setOpen] = useState(false);
  const label = `Delete ${kind} ${name}`;
  return (
    <>
      {icon ? (
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={label}
          title={label}
          data-testid={`delete-${kind}-${id}`}
          onClick={() => {
            setOpen(true);
          }}
        >
          <Trash2 />
        </Button>
      ) : (
        <Button
          size="sm"
          variant="outline"
          className="text-destructive"
          data-testid={`delete-${kind}`}
          onClick={() => {
            setOpen(true);
          }}
        >
          <Trash2 />
          Delete
        </Button>
      )}
      {open && (
        <DeleteDialog
          kind={kind}
          id={id}
          name={name}
          after={after}
          onClose={() => {
            setOpen(false);
          }}
        />
      )}
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-sm font-medium">{title}</h3>
      {children}
    </section>
  );
}

function Paths({ paths, testId }: { paths: string[]; testId: string }) {
  return (
    <ul
      className="max-h-40 overflow-auto rounded-md bg-muted px-2 py-1 font-mono text-xs"
      data-testid={testId}
    >
      {paths.map((p) => (
        <li key={p} className="truncate" title={p}>
          {p}
        </li>
      ))}
    </ul>
  );
}

function DeleteDialog({
  kind,
  id,
  name,
  after,
  onClose,
}: {
  kind: Kind;
  id: string;
  name: string;
  after: string | undefined;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const plan = useQuery({
    queryKey: ['delete-plan', kind, id],
    queryFn: async () =>
      (await requestJson('GET', `${base(kind, id)}/delete-plan`)) as DeletionPlan,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  const variants = useQuery(variantsQuery);
  const [choice, setChoice] = useState<'delete' | 'rebind'>('rebind');
  const [rebindTo, setRebindTo] = useState('');
  const [typed, setTyped] = useState('');
  const remove = useMutation({
    mutationFn: async () => {
      const sessions: SessionsChoice =
        choice === 'delete' ? 'delete' : { rebindTo: rebindTo === '' ? null : rebindTo };
      return (await requestJson('DELETE', base(kind, id), { sessions })) as DeletionPlan;
    },
    onSuccess: async () => {
      if (after !== undefined) await navigate(after);
      onClose();
      await client.invalidateQueries();
    },
  });
  const p = plan.data;
  const removing = new Set((p?.variants ?? []).map((v) => v.id));
  const targets = (variants.data ?? []).filter((v) => !removing.has(v.id));
  const workflows = [...new Set(targets.map((v) => v.workflowId))];
  const blocked = p !== undefined && p.blockers.length > 0;
  const ready = p !== undefined && !blocked && typed === name && !remove.isPending;
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
          className="fixed top-1/2 left-1/2 z-[60] flex max-h-[90vh] w-[min(46rem,94vw)] -translate-x-1/2 -translate-y-1/2 flex-col gap-3 rounded-lg border bg-background p-4 shadow-lg"
          data-testid="delete-dialog"
          aria-describedby={undefined}
        >
          <div className="flex items-center gap-3">
            <Dialog.Title className="text-base font-semibold">
              Delete {kind} {name}
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
                <Alert variant="destructive" data-testid="delete-blockers">
                  <AlertTitle>Can't delete right now</AlertTitle>
                  <AlertDescription>
                    <ul className="list-disc pl-4">
                      {p.blockers.map((b) => (
                        <li key={`${b.kind}:${b.id}`}>{b.label}</li>
                      ))}
                    </ul>
                  </AlertDescription>
                </Alert>
              )}
              {kind === 'workflow' && (
                <p className="text-sm">
                  Also deletes its {formatNoun(p.variants.length, 'variant')}
                  {p.drafts.length > 0 &&
                    `, ${formatNoun(p.drafts.length, 'draft')} and the drafts' Live items`}
                  .
                </p>
              )}
              <Section title="Directories to delete">
                {p.dirs.length === 0 ? (
                  <p className="text-sm text-muted-foreground">
                    No directories to delete (shared with other variants).
                  </p>
                ) : (
                  <Paths paths={p.dirs} testId="delete-dirs" />
                )}
                {p.installs.length > 0 && (
                  <>
                    <p className="text-sm">Installed on this machine; uninstalled first from:</p>
                    <Paths paths={p.installs.flatMap((i) => i.dirs)} testId="delete-installs" />
                  </>
                )}
              </Section>
              <Section title={`Linked sessions (${String(p.sessions.count)})`}>
                <div
                  className="flex flex-col gap-2 text-sm"
                  role="radiogroup"
                  aria-label="Linked sessions"
                >
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="sessions"
                      data-testid="delete-sessions-rebind"
                      checked={choice === 'rebind'}
                      onChange={() => {
                        setChoice('rebind');
                      }}
                    />
                    Rebind to
                    <select
                      className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2"
                      aria-label="Rebind to"
                      data-testid="delete-rebind-target"
                      value={rebindTo}
                      disabled={choice !== 'rebind'}
                      onChange={(event) => {
                        setRebindTo(event.target.value);
                      }}
                    >
                      <option value="">Local config (unbound)</option>
                      {workflows.map((w) => (
                        <optgroup key={w} label={w}>
                          {targets
                            .filter((v) => v.workflowId === w)
                            .map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.name}
                              </option>
                            ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                  <label className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="sessions"
                      data-testid="delete-sessions-delete"
                      checked={choice === 'delete'}
                      onChange={() => {
                        setChoice('delete');
                      }}
                    />
                    Delete them too: the sessions and their original files on disk
                    {p.sessions.liveItems.length > 0 &&
                      `, plus ${formatNoun(p.sessions.liveItems.length, 'Live item')}`}
                  </label>
                  {choice === 'delete' && p.sessions.files.length > 0 && (
                    <Paths paths={p.sessions.files} testId="delete-session-files" />
                  )}
                  {p.sessions.agent > 0 && (
                    <p className="text-muted-foreground" data-testid="delete-agent-sessions">
                      Plus {formatNoun(p.sessions.agent, 'Magi Agent session')} on the local config
                      (~/.claude): not deleted, and neither are their Live items; with "Delete them
                      too" they move to the local config.
                    </p>
                  )}
                </div>
              </Section>
              <Section title='Records kept (shown as "name (deleted)")'>
                <p className="text-sm text-muted-foreground" data-testid="delete-retained">
                  {formatNoun(p.retained.runs, 'run')} (
                  {formatNoun(p.retained.runSessions, 'session')} kept with the runs) ·{' '}
                  {formatNoun(p.retained.analyses, 'analysis', 'analyses')} ·{' '}
                  {formatNoun(p.retained.liveItems, 'Live item')} ·{' '}
                  {formatNoun(p.retained.drafts, 'draft')}
                  {p.retained.children.length > 0 &&
                    ` · Derived variants: ${p.retained.children.map((c) => c.name).join(', ')}`}
                </p>
              </Section>
            </div>
          )}
          {remove.isError && (
            <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
              {remove.error.message}
            </p>
          )}
          <div className="flex items-center gap-2 border-t pt-3">
            <label className="flex min-w-0 flex-1 items-center gap-2 text-sm">
              Type the name to confirm
              <Input
                className="h-8 min-w-0 flex-1"
                placeholder={name}
                data-testid="delete-confirm-name"
                value={typed}
                onChange={(event) => {
                  setTyped(event.target.value);
                }}
              />
            </label>
            <Button
              size="sm"
              variant="destructive"
              data-testid="delete-confirm"
              disabled={!ready}
              onClick={() => {
                remove.mutate();
              }}
            >
              <Trash2 />
              {remove.isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
