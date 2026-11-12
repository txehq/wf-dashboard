import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { EngineChoice } from '@/components/engine-choice';
import { useSessionVariant } from '@/components/session-variant';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { createDraft, type Draft, type DraftStepView } from '@/lib/drafts-api';
import { formatDuration } from '@/lib/format';
import { useDesignEngine } from '@/lib/design-engine';
import { useNow } from '@/lib/use-now';
import { type Variant, variantLabel, variantsQuery } from '@/pages/variants-api';

// The earliest variant (the list is newest first): the default base
function earliest(variants: Variant[]): Variant | undefined {
  return variants.reduce<Variant | undefined>(
    (first, v) => (first === undefined || v.createdAt < first.createdAt ? v : first),
    undefined,
  );
}

// Contracts 17.1, 22.1, 28.4: "Generate workflow" (Workflows list) and "Generate variant" (Workflow page), with
// Codex or Claude Code as the engine (defaults to the last choice). On start the server creates the draft
// directory, installs skills and creates a Live session; the page navigates to it
export function CodexDraftForm({
  mode,
  workflowId,
  onCancel,
}: {
  mode: 'workflow' | 'variant';
  // The owning workflow when mode is variant
  workflowId?: string | undefined;
  onCancel: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const variants = useQuery(variantsQuery);
  // In variant mode the base defaults to this workflow's first variant; workflow mode starts from a blank skeleton (Contracts 18.5)
  const choices = (variants.data ?? []).filter((v) => v.workflowId === workflowId);
  const fallback = earliest(choices);
  const [engine, setEngine] = useDesignEngine();
  const [baseVariantId, setBaseVariantId] = useState('');
  const base = baseVariantId === '' ? (fallback?.id ?? '') : baseVariantId;
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [requirement, setRequirement] = useState('');
  const session = useSessionVariant('design');
  const create = useMutation({
    mutationFn: () =>
      createDraft(
        mode === 'workflow'
          ? {
              mode,
              engine,
              designVariantId: session.variantId,
              workflowId: id,
              name,
              description,
              requirement,
            }
          : {
              mode,
              engine,
              designVariantId: session.variantId,
              workflowId: workflowId ?? '',
              requirement,
              baseVariantId: base,
            },
      ),
    onSuccess: async ({ live }) => {
      await client.invalidateQueries({ queryKey: ['live'] });
      await navigate(`/live?item=${live.id}`);
    },
  });
  const ready =
    session.variantId !== '' &&
    requirement.trim() !== '' &&
    (mode === 'variant' ? base !== '' : id !== '' && name !== '');
  return (
    <form
      className="flex flex-col gap-4 rounded-lg border p-4"
      data-testid={`codex-draft-${mode}`}
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">
          {mode === 'workflow' ? 'Generate workflow' : `Generate a variant of /${workflowId ?? ''}`}
        </h2>
        <EngineChoice value={engine} onChange={setEngine} />
        {session.select}
      </div>
      <div className="flex flex-wrap items-end gap-3">
        {mode === 'workflow' && (
          <>
            <label className="flex flex-col gap-1 text-sm">
              id (entry command /id)
              <input
                className="h-9 w-48 rounded-md border px-3 font-mono"
                data-testid="codex-draft-id"
                value={id}
                onChange={(event) => {
                  setId(event.target.value);
                }}
                required
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              Name
              <input
                className="h-9 w-56 rounded-md border px-3"
                data-testid="codex-draft-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
                required
              />
            </label>
          </>
        )}
        {mode === 'variant' && (
          <label className="flex flex-col gap-1 text-sm">
            Base variant
            <select
              className="h-9 w-72 rounded-md border bg-background px-2"
              data-testid="codex-draft-base"
              value={base}
              onChange={(event) => {
                setBaseVariantId(event.target.value);
              }}
              required
            >
              {base === '' && <option value="">Select…</option>}
              {choices.map((v) => (
                <option key={v.id} value={v.id}>
                  {variantLabel(v)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {mode === 'workflow' && (
        <label className="flex flex-col gap-1 text-sm">
          Description
          <textarea
            className="min-h-14 rounded-md border px-3 py-2"
            data-testid="codex-draft-description"
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        Requirements
        <textarea
          className="min-h-20 rounded-md border px-3 py-2"
          data-testid="codex-draft-requirement"
          value={requirement}
          onChange={(event) => {
            setRequirement(event.target.value);
          }}
          required
        />
      </label>
      <p className="text-sm text-muted-foreground">
        {mode === 'workflow'
          ? 'The draft starts from a blank skeleton (SKILL.md for the entry and one stage). When the skills and stages are written, save it as a new workflow in Live.'
          : 'Only skill content changes; the entry and stages stay the same. When done, save it as a new variant in Live.'}
      </p>
      {create.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not start</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">
            {create.error.message}
          </AlertDescription>
        </Alert>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          disabled={!ready || create.isPending}
          data-testid="codex-draft-submit"
        >
          <Sparkles />
          {create.isPending ? 'Starting…' : 'Start in Live'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

const stepLabel: Record<DraftStepView['status'], string> = {
  pending: 'Pending',
  running: 'Running…',
  done: 'Done',
  failed: 'Failed',
};

// A step's actual duration: start to end when done or failed, start to now while running
function stepDuration(step: DraftStepView, now: number): string | null {
  if (step.startedAt === null) return null;
  return formatDuration((step.endedAt ?? now) - step.startedAt);
}

// Each draft preparation step (Contracts 17.1, 28.4) with its actual duration; on failure, the step's raw error and "Retry preparation"
export function DraftProgress({
  draft,
  retrying,
  onRetry,
}: {
  draft: Draft;
  retrying: boolean;
  onRetry: () => void;
}) {
  const now = useNow(draft.status === 'preparing');
  return (
    <div
      className="flex flex-col gap-2 rounded-md border p-3 text-sm"
      data-testid="codex-draft-progress"
      data-status={draft.status}
    >
      <p className="font-medium">
        {draft.status === 'preparing'
          ? `Preparing the draft directory; ${draft.engine === 'codex' ? 'Codex' : 'Claude Code'} starts when it is ready`
          : 'Preparation failed. The draft is kept.'}
      </p>
      <ol className="flex flex-col gap-1">
        {draft.steps.map((step) => {
          const duration = stepDuration(step, now);
          return (
            <li
              key={step.id}
              data-testid="codex-draft-step"
              data-step={step.id}
              data-status={step.status}
            >
              <span className="inline-block w-16 text-muted-foreground">
                {stepLabel[step.status]}
              </span>
              {step.label}
              {duration !== null && (
                <span
                  className="ml-2 text-xs text-muted-foreground tabular-nums"
                  data-testid="codex-draft-step-duration"
                >
                  {duration}
                </span>
              )}
              {step.error !== null && (
                <pre className="mt-1 max-h-60 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap text-destructive">
                  {step.error}
                </pre>
              )}
            </li>
          );
        })}
      </ol>
      {draft.status === 'failed' && (
        <Button
          size="sm"
          variant="outline"
          className="w-fit"
          data-testid="codex-draft-retry"
          disabled={retrying}
          onClick={onRetry}
        >
          <RotateCcw />
          Retry preparation
        </Button>
      )}
    </div>
  );
}
