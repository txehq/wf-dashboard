import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { type ReactNode, useState } from 'react';
import { useNavigate } from 'react-router';
import { DiffViewTypeToggle } from '@/components/diff';
import { SourceDiff, SourceDiffSummary } from '@/components/source-diff';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  type Draft,
  draftDiffQuery,
  type SaveDraftBody,
  type SavePlan,
  saveDraft,
  savePlanQuery,
} from '@/lib/drafts-api';
import { cn } from '@/lib/utils';
import { variantHref } from '@/pages/variants-api';

type VariantPlan = Extract<SavePlan, { kind: 'variant' }>;
type NewWorkflowPlan = Extract<SavePlan, { kind: 'new-workflow' }>;

const filled = (...values: string[]) => values.every((v) => v.trim() !== '');

// Save dialog (Contracts 17.4, 19.3): on the left, where to save plus name and description; on the right, the diff of
// src/ against the target. Saving does not build; after saving the page goes to the variant page, where it is built
export function CodexSaveDialog({ draft, onClose }: { draft: Draft; onClose: () => void }) {
  const plan = useQuery(savePlanQuery(draft.id));
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/30" />
        <Dialog.Content
          className="fixed inset-x-[3vw] inset-y-[4vh] z-[60] flex flex-col gap-3 rounded-lg border bg-background p-4 shadow-lg"
          data-testid="codex-save-dialog"
          aria-describedby={undefined}
        >
          {plan.isSuccess ? (
            plan.data.kind === 'new-workflow' ? (
              <NewWorkflowSave draft={draft} plan={plan.data} onClose={onClose} />
            ) : (
              <VariantSave draft={draft} plan={plan.data} onClose={onClose} />
            )
          ) : (
            <>
              <Header title="Save draft" onClose={onClose} />
              {plan.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
              {plan.isError && (
                <Alert variant="destructive" data-testid="codex-save-error">
                  <AlertTitle>Cannot save. The draft is kept.</AlertTitle>
                  <AlertDescription className="font-mono text-xs whitespace-pre-wrap">
                    {plan.error.message}
                  </AlertDescription>
                </Alert>
              )}
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Header({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
      {subtitle !== undefined && <span className="text-xs text-muted-foreground">{subtitle}</span>}
      <div className="ml-auto flex items-center gap-2">
        {children}
        <Button size="sm" variant="ghost" onClick={onClose}>
          <X />
          Cancel
        </Button>
      </div>
    </div>
  );
}

function useSave(draft: Draft) {
  const client = useQueryClient();
  const navigate = useNavigate();
  return useMutation({
    mutationFn: (body: SaveDraftBody) => saveDraft(draft.id, body),
    onSuccess: async (saved) => {
      await client.invalidateQueries({ queryKey: ['drafts'] });
      await client.invalidateQueries({ queryKey: ['workflows'] });
      await client.invalidateQueries({ queryKey: ['variants'] });
      // The panel's "Compare" gains "Last saved"
      await client.invalidateQueries({ queryKey: ['workspace', draft.liveId] });
      if (saved.savedVariantId === null)
        throw new Error(`Draft ${draft.id} has no variant after saving`);
      await navigate(variantHref({ id: saved.savedVariantId }));
    },
  });
}

function Field({
  label,
  value,
  onChange,
  multiline = false,
  testId,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  testId: string;
  placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span>
        {label} <span className="text-destructive">*</span>
      </span>
      {multiline ? (
        <Textarea
          className="min-h-16"
          data-testid={testId}
          value={value}
          placeholder={placeholder}
          required
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      ) : (
        <Input
          data-testid={testId}
          value={value}
          placeholder={placeholder}
          required
          onChange={(event) => {
            onChange(event.target.value);
          }}
        />
      )}
    </label>
  );
}

// The form on the left and the diff on the right; the Save button is in the header row
function Layout({
  draft,
  title,
  subtitle,
  against,
  againstHint,
  ready,
  save,
  body,
  onClose,
  children,
}: {
  draft: Draft;
  title: string;
  subtitle: string;
  // The variant being overwritten; null for a new variant, in which case the diff is against the base
  against: string | null;
  // Hint shown while no variant to overwrite is selected yet
  againstHint: string | null;
  ready: boolean;
  save: ReturnType<typeof useSave>;
  body: () => SaveDraftBody;
  onClose: () => void;
  children: ReactNode;
}) {
  const diff = useQuery({ ...draftDiffQuery(draft.id, against), enabled: againstHint === null });
  return (
    <>
      <Header title={title} subtitle={subtitle} onClose={onClose}>
        {diff.isSuccess && <SourceDiffSummary files={diff.data.files} />}
        <DiffViewTypeToggle />
        <Button
          size="sm"
          data-testid="codex-save-confirm"
          disabled={!ready || save.isPending}
          title="Once validated, saves as an unbuilt variant; build it on the variant page"
          onClick={() => {
            save.mutate(body());
          }}
        >
          <Save />
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </Header>
      <div className="flex min-h-0 flex-1 gap-4">
        <form
          className="flex w-80 shrink-0 flex-col gap-3 overflow-auto pr-1"
          data-testid="codex-save-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready) save.mutate(body());
          }}
        >
          {children}
          <p className="text-xs text-muted-foreground">
            Saving does not build. Build on the variant page.
          </p>
          {save.isError && (
            <Alert variant="destructive" data-testid="codex-save-error">
              <AlertTitle>Save failed. The draft is kept.</AlertTitle>
              <AlertDescription className="max-h-60 overflow-auto font-mono text-xs whitespace-pre-wrap">
                {save.error.message}
              </AlertDescription>
            </Alert>
          )}
        </form>
        <div className="min-w-0 flex-1 overflow-auto" data-testid="codex-save-diff">
          <p className="mb-2 text-xs text-muted-foreground" data-testid="codex-save-against">
            {againstHint ??
              (diff.data === undefined
                ? 'Comparing…'
                : diff.data.base === null
                  ? 'Starts from blank with no base; every file is added'
                  : against === null
                    ? `Against base ${diff.data.base.name}`
                    : `Against ${diff.data.base.name}, which will be overwritten`)}
          </p>
          {diff.isError && (
            <pre role="alert" className="text-xs whitespace-pre-wrap text-destructive">
              {diff.error.message}
            </pre>
          )}
          {diff.isSuccess && (
            <SourceDiff files={diff.data.files} empty="The skills match the target. No changes." />
          )}
        </div>
      </div>
    </>
  );
}

// First save as a new workflow: names and descriptions of the workflow and its first variant
function NewWorkflowSave({
  draft,
  plan,
  onClose,
}: {
  draft: Draft;
  plan: NewWorkflowPlan;
  onClose: () => void;
}) {
  const save = useSave(draft);
  const [workflowName, setWorkflowName] = useState(plan.workflowName);
  const [workflowDescription, setWorkflowDescription] = useState(plan.workflowDescription);
  const [name, setName] = useState(plan.variantName);
  const [description, setDescription] = useState('');
  return (
    <Layout
      draft={draft}
      title="Save as new workflow"
      subtitle={`Entry /${plan.workflowId}`}
      against={null}
      againstHint={null}
      ready={filled(workflowName, workflowDescription, name, description)}
      save={save}
      body={() => ({
        target: { kind: 'new', name, description },
        workflow: { name: workflowName, description: workflowDescription },
      })}
      onClose={onClose}
    >
      <fieldset className="flex flex-col gap-2 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">Workflow</legend>
        <Field
          label="Name"
          value={workflowName}
          onChange={setWorkflowName}
          testId="codex-save-workflow-name"
        />
        <Field
          label="Description"
          multiline
          value={workflowDescription}
          onChange={setWorkflowDescription}
          testId="codex-save-workflow-description"
        />
      </fieldset>
      <fieldset className="flex flex-col gap-2 rounded-md border p-3">
        <legend className="px-1 text-sm font-medium">First variant</legend>
        <Field label="Name" value={name} onChange={setName} testId="codex-save-name" />
        <Field
          label="Description"
          multiline
          value={description}
          placeholder="What this version does"
          onChange={setDescription}
          testId="codex-save-description"
        />
      </fieldset>
    </Layout>
  );
}

// Save to an existing workflow: a new variant, or overwrite one of them (imported and frozen ones are greyed out with the reason)
function VariantSave({
  draft,
  plan,
  onClose,
}: {
  draft: Draft;
  plan: VariantPlan;
  onClose: () => void;
}) {
  const save = useSave(draft);
  const [kind, setKind] = useState<'new' | 'overwrite'>('new');
  const [target, setTarget] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const choose = (next: 'new' | 'overwrite') => {
    setKind(next);
    if (next === 'new') {
      setName('');
      setDescription('');
    } else {
      const chosen = plan.variants.find((v) => v.id === target);
      setName(chosen?.name ?? '');
      setDescription(chosen?.description ?? '');
    }
  };
  const pick = (v: VariantPlan['variants'][number]) => {
    setTarget(v.id);
    setName(v.name);
    setDescription(v.description ?? '');
  };
  const overwriting = kind === 'overwrite';
  return (
    <Layout
      draft={draft}
      title="Save draft"
      subtitle={`Save to workflow ${plan.workflowName} (/${plan.workflowId})`}
      against={overwriting ? target : null}
      againstHint={
        overwriting && target === null
          ? 'Select a variant to overwrite to see what it will become.'
          : null
      }
      ready={filled(name, description) && (!overwriting || target !== null)}
      save={save}
      body={() =>
        overwriting && target !== null
          ? { target: { kind: 'overwrite', variantId: target, name, description } }
          : { target: { kind: 'new', name, description } }
      }
      onClose={onClose}
    >
      <div className="flex gap-4 text-sm" role="radiogroup" aria-label="Save as">
        {(
          [
            ['new', 'New variant'],
            ['overwrite', 'Overwrite a variant'],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="flex items-center gap-1.5">
            <input
              type="radio"
              name="save-kind"
              data-testid={`codex-save-kind-${value}`}
              checked={kind === value}
              onChange={() => {
                choose(value);
              }}
            />
            {label}
          </label>
        ))}
      </div>
      {!overwriting && plan.parent !== null && (
        <p className="text-xs text-muted-foreground">Derived from {plan.parent.name}</p>
      )}
      {overwriting && (
        <ul className="flex flex-col gap-1" data-testid="codex-save-targets">
          {plan.variants.map((v) => (
            <li key={v.id}>
              <label
                className={cn(
                  'flex items-start gap-2 rounded-md border px-2 py-1.5 text-sm',
                  v.reason === null ? 'cursor-pointer hover:bg-muted' : 'opacity-50',
                  target === v.id && 'border-primary bg-muted',
                )}
                data-testid="codex-save-target"
                data-variant={v.id}
                data-disabled={v.reason !== null}
              >
                <input
                  type="radio"
                  name="save-target"
                  className="mt-1"
                  disabled={v.reason !== null}
                  checked={target === v.id}
                  onChange={() => {
                    pick(v);
                  }}
                />
                <span className="min-w-0">
                  <span className="block truncate">{v.name}</span>
                  {v.reason !== null && (
                    <span className="block text-xs text-muted-foreground">{v.reason}</span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <Field label="Name" value={name} onChange={setName} testId="codex-save-name" />
      <Field
        label="Description"
        multiline
        value={description}
        placeholder="What this version does"
        onChange={setDescription}
        testId="codex-save-description"
      />
      {overwriting && (
        <p className="text-xs text-muted-foreground">
          The current src is kept in this variant's history and can be restored on the variant page.
        </p>
      )}
    </Layout>
  );
}
