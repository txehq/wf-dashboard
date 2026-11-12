import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Save, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { CodexDraftForm } from '@/components/codex-draft';
import { DescriptionEditor } from '@/components/description-editor';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { StageFlow } from '@/components/workflow-flow';
import { cn } from '@/lib/utils';
import { formatDateTime } from '@/lib/format';
import { definitionYaml, parseDefinitionYaml } from '@/lib/workflow-yaml';
import {
  evalKindLabel,
  updateWorkflow,
  type WorkflowRecord,
  workflowQuery,
} from '@/lib/workflows-api';
import {
  allVariantsQuery,
  buildLabel,
  filesQuery,
  request,
  type Variant,
  variantHref,
  variantLabel,
  variantsQuery,
} from '@/pages/variants-api';
import { DefinitionForm, DefinitionYamlEditor } from '@/pages/workflow-config';
import { VariantRows } from '@/pages/workflows';
import { DeleteButton } from '@/components/delete-dialog';

type ConfigTab = 'form' | 'yaml';

// Config of the entry command and stages: the form and YAML edit the same definition and the flow chart follows
// (Contracts 18.4); read-only for built-in workflows
function ConfigSection({ workflow, variants }: { workflow: WorkflowRecord; variants: Variant[] }) {
  const client = useQueryClient();
  const [tab, setTab] = useState<ConfigTab>('form');
  const [text, setText] = useState(() => definitionYaml(workflow.definition));
  const parsed = parseDefinitionYaml(text);
  const readOnly = workflow.builtin;
  // Skill names already in this workflow's variants, suggested when adding a stage; not needed when read-only
  const files = useQueries({
    queries: readOnly ? [] : variants.map((v) => filesQuery(v.id)),
  });
  const skillNames = [
    ...new Set(files.flatMap((f) => f.data?.map((file) => file.path.split('/')[1] ?? '') ?? [])),
  ]
    .filter((n) => n !== '')
    .sort();
  const save = useMutation({
    mutationFn: () => {
      if (!parsed.ok) throw new Error('The definition has errors and cannot be saved');
      return updateWorkflow(workflow.id, {
        name: parsed.definition.name,
        description: workflow.description ?? '',
        definition: parsed.definition,
      });
    },
    onSuccess: async (saved) => {
      // After saving, the text is the server's canonical form of the definition
      setText(definitionYaml(saved.definition));
      await client.invalidateQueries({ queryKey: ['workflows'] });
    },
  });
  const changed = text !== definitionYaml(workflow.definition);
  return (
    <section className="flex flex-col gap-3" data-testid="workflow-config">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" className="flex gap-1 border-b">
          {(
            [
              ['form', 'Form'],
              ['yaml', 'YAML'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={cn(
                '-mb-px border-b-2 border-transparent px-3 py-1.5 text-sm text-muted-foreground',
                tab === id && 'border-foreground font-medium text-foreground',
              )}
              onClick={() => {
                setTab(id);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {!readOnly && (
          <Button
            className="ml-auto"
            size="sm"
            disabled={!parsed.ok || !changed || save.isPending}
            onClick={() => {
              save.mutate();
            }}
          >
            <Save />
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
        )}
      </div>
      {readOnly && (
        <p className="text-sm text-muted-foreground">
          Built-in workflows can only change their description. To use a different entry or stages,
          create a new workflow from blank.
        </p>
      )}
      {tab === 'form' &&
        (parsed.ok ? (
          <DefinitionForm
            definition={parsed.definition}
            skillNames={skillNames}
            readOnly={readOnly}
            onChange={(definition) => {
              setText(definitionYaml(definition));
            }}
          />
        ) : (
          <p className="text-sm text-destructive">
            The YAML has errors. Fix them to show the form.
          </p>
        ))}
      {tab === 'yaml' && (
        <DefinitionYamlEditor
          key={workflow.id}
          text={text}
          readOnly={readOnly}
          issues={parsed.ok ? [] : parsed.issues}
          onChange={setText}
        />
      )}
      {!parsed.ok && (
        <ul className="flex flex-col gap-1 text-sm text-destructive" data-testid="workflow-issues">
          {parsed.issues.map((issue) => (
            <li key={`${String(issue.line)}:${issue.message}`}>
              Line {issue.line}: {issue.message}
            </li>
          ))}
        </ul>
      )}
      {save.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not save</AlertTitle>
          <AlertDescription>{save.error.message}</AlertDescription>
        </Alert>
      )}
      {save.isSuccess && !changed && (
        <p className="text-sm text-muted-foreground" data-testid="workflow-saved">
          Saved.
        </p>
      )}
      <h2 className="text-lg font-semibold">Stage flow</h2>
      {parsed.ok ? (
        <StageFlow definition={parsed.definition} />
      ) : (
        <p className="text-sm text-muted-foreground">
          The definition has errors. Fix them to show the flow chart.
        </p>
      )}
    </section>
  );
}

// Import a baseline from a txe-workflow commit: only for the built-in lfg and ic (a variant of any workflow has one set of skills)
function ImportBaseline({ workflowId }: { workflowId: string }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [commit, setCommit] = useState('');
  const create = useMutation({
    mutationFn: () =>
      request<Variant>('POST', '/api/variants', {
        name,
        workflowId,
        ...(commit.trim() === '' ? {} : { commit: commit.trim() }),
      }),
    onSuccess: async (variant) => {
      await client.invalidateQueries({ queryKey: ['variants'] });
      await navigate(variantHref(variant));
    },
  });
  return (
    <form
      className="flex flex-wrap items-end gap-3"
      data-testid="import-baseline"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        Name
        <input
          className="h-9 w-56 rounded-md border px-3"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        txe-workflow commit
        <input
          className="h-9 w-56 rounded-md border px-3 font-mono"
          placeholder="HEAD"
          value={commit}
          onChange={(event) => {
            setCommit(event.target.value);
          }}
        />
      </label>
      <Button type="submit" variant="outline" disabled={create.isPending || name.trim() === ''}>
        {create.isPending ? 'Importing…' : 'Import baseline'}
      </Button>
      {create.isError && <p className="text-sm text-destructive">{create.error.message}</p>}
    </form>
  );
}

// Latest txe-workflow release for lfg and ic (Contracts 29.1): the tag, the variant it auto-imported and its build
// status, and the raw error when the check failed
function ReleaseLine({ workflow, variants }: { workflow: WorkflowRecord; variants: Variant[] }) {
  const all = useQuery(allVariantsQuery);
  const release = workflow.release;
  if (release === null) return null;
  const variant = variants.find((v) => v.id === release.variantId);
  const deleted =
    release.tag !== null &&
    (all.data ?? []).some(
      (v) => v.workflowId === workflow.id && v.releaseTag === release.tag && v.deletedAt !== null,
    );
  return (
    <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm" data-testid="release-line">
      <span>
        Latest txe-workflow release{' '}
        <span className="font-mono font-medium">{release.tag ?? '—'}</span>
      </span>
      {variant !== undefined && (
        <>
          <span className="text-muted-foreground">·</span>
          <Link
            className="font-medium underline-offset-4 hover:underline"
            to={variantHref(variant)}
          >
            {variant.name}
          </Link>
          <span className="text-muted-foreground">·</span>
          <span data-testid="release-build">{buildLabel(variant)}</span>
        </>
      )}
      {variant === undefined && deleted && (
        <span className="text-muted-foreground">
          · Its variant was deleted and will not be imported again
        </span>
      )}
      {variant === undefined && !deleted && release.tag !== null && release.error === null && (
        <span className="text-muted-foreground">· Importing</span>
      )}
      <span className="text-xs text-muted-foreground">
        Checked {formatDateTime(new Date(release.checkedAt).toISOString())}
      </span>
      {release.error !== null && (
        <span className="basis-full break-words text-destructive" data-testid="release-error">
          Check failed: {release.error}
        </span>
      )}
    </p>
  );
}

// This workflow's variants, names linking to the variant page (Contracts 18.3); a new variant is derived from the selected one
function VariantsSection({
  workflow,
  variants,
}: {
  workflow: WorkflowRecord;
  variants: (Variant & { boundSessions: number })[];
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [codexing, setCodexing] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const source = variants.find((v) => v.id === sourceId) ?? variants[0];
  const derive = useMutation({
    mutationFn: ({ from, name }: { from: string; name: string }) =>
      request<Variant>('POST', `/api/variants/${from}/derive`, { name }),
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: ['variants'] });
      await navigate(variantHref(created));
    },
  });
  return (
    <section className="flex flex-col gap-3" data-testid="workflow-variants">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">Variants</h2>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {variants.length > 0 && (
            <select
              className="h-8 rounded-md border bg-background px-2 text-sm"
              aria-label="Derive from"
              value={source?.id ?? ''}
              onChange={(event) => {
                setSourceId(event.target.value);
              }}
            >
              {variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {variantLabel(v)}
                </option>
              ))}
            </select>
          )}
          <Button
            size="sm"
            disabled={source === undefined || derive.isPending}
            onClick={() => {
              if (source === undefined) return;
              const name = window.prompt(
                `Name of the new variant (derived from ${source.name})`,
                '',
              );
              if (name !== null && name.trim() !== '') {
                derive.mutate({ from: source.id, name: name.trim() });
              }
            }}
          >
            <Plus />
            New variant
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="codex-variant-toggle"
            onClick={() => {
              setCodexing(!codexing);
            }}
          >
            <Sparkles />
            Generate variant
          </Button>
        </div>
      </div>
      {codexing && (
        <CodexDraftForm
          mode="variant"
          workflowId={workflow.id}
          onCancel={() => {
            setCodexing(false);
          }}
        />
      )}
      {derive.isError && <p className="text-sm text-destructive">{derive.error.message}</p>}
      {workflow.wf && <ImportBaseline workflowId={workflow.id} />}
      <ReleaseLine workflow={workflow} variants={variants} />
      <VariantRows variants={variants} latestTag={workflow.release?.tag ?? null} />
    </section>
  );
}

// Contracts 16.7, 18.4: the Workflow page
export function WorkflowPage() {
  const { id } = useParams();
  if (id === undefined) throw new Error('The route has no workflow id');
  const client = useQueryClient();
  const workflow = useQuery(workflowQuery(id));
  const variants = useQuery(variantsQuery);
  if (workflow.isPending || variants.isPending) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (workflow.isError || variants.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load the workflow</AlertTitle>
        <AlertDescription>{(workflow.error ?? variants.error)?.message}</AlertDescription>
      </Alert>
    );
  }
  const w = workflow.data;
  const own = variants.data.filter((v) => v.workflowId === w.id);
  // Switching to another workflow remounts the page by id, so description and config edits switch with it
  return (
    <div key={w.id} className="flex flex-col gap-6">
      <Button asChild variant="ghost" className="w-fit">
        <Link to="/workflows">
          <ArrowLeft />
          All workflows
        </Link>
      </Button>
      <div className="flex flex-col gap-1">
        {/* Delete sits on the title row (Contracts 24.6); built-in workflows cannot be deleted */}
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold">{w.name}</h1>
          {!w.builtin && (
            <span className="ml-auto">
              <DeleteButton kind="workflow" id={w.id} name={w.name} after="/workflows" />
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground" data-testid="workflow-summary">
          Entry <span className="font-mono text-foreground">/{w.id}</span> · Eval kind{' '}
          {evalKindLabel(w.evalKind)}
        </p>
      </div>
      <DescriptionEditor
        label="Description"
        value={w.description}
        onSave={async (description) => {
          await updateWorkflow(w.id, { name: w.name, description, definition: w.definition });
          await client.invalidateQueries({ queryKey: ['workflows'] });
        }}
      />
      <ConfigSection workflow={w} variants={own} />
      <VariantsSection workflow={w} variants={own} />
    </div>
  );
}
