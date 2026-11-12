import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkflowDefinition } from '@wf-dashboard/server/workflows/schema';
import { ChevronDown, ChevronRight, Plus, Sparkles } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { CodexDraftForm } from '@/components/codex-draft';
import { DeleteButton } from '@/components/delete-dialog';
import { PageShell } from '@/components/page-shell';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { VariantName } from '@/components/variant-name';
import { StageFlow } from '@/components/workflow-flow';
import { formatDateTime } from '@/lib/format';
import {
  createWorkflow,
  evalKindLabel,
  type WorkflowRecord,
  workflowsQuery,
} from '@/lib/workflows-api';
import {
  buildLabel,
  importedLabel,
  isImported,
  statusLabel,
  type Variant,
  variantHref,
  variantsQuery,
} from '@/pages/variants-api';
import { DefinitionForm } from '@/pages/workflow-config';

// New from blank (Contracts 18.5): id, name, description and stages; no eval kind. Also creates the first variant
function BlankWorkflowForm({ onCancel }: { onCancel: () => void }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [id, setId] = useState('');
  const [description, setDescription] = useState('');
  const [definition, setDefinition] = useState<WorkflowDefinition>({
    id: '',
    name: '',
    stages: [],
  });
  const create = useMutation({
    mutationFn: () =>
      createWorkflow({
        id,
        name: definition.name,
        description,
        definition: { ...definition, id },
      }),
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: ['workflows'] });
      await client.invalidateQueries({ queryKey: ['variants'] });
      await navigate(`/workflows/${created.id}`);
    },
  });
  const ready = id !== '' && definition.name.trim() !== '' && definition.stages.length > 0;
  return (
    <form
      className="flex flex-col gap-4 rounded-lg border p-4"
      data-testid="new-workflow"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <h2 className="text-base font-semibold">New workflow from blank</h2>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">id (entry command /id, also the entry skill's name)</span>
        <input
          className="h-9 w-56 rounded-md border bg-background px-3 font-mono"
          value={id}
          onChange={(event) => {
            setId(event.target.value.trim());
          }}
          required
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Description</span>
        <textarea
          className="min-h-16 max-w-3xl rounded-md border bg-background px-3 py-2"
          value={description}
          placeholder="One sentence on what it does"
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
      </label>
      <DefinitionForm
        definition={{ ...definition, id }}
        skillNames={[]}
        readOnly={false}
        onChange={setDefinition}
      />
      {id !== '' && definition.stages.length > 0 && (
        <StageFlow definition={{ ...definition, id }} />
      )}
      <p className="text-sm text-muted-foreground">
        The new workflow starts with one variant: a SKILL.md with only frontmatter and one line of
        description for the entry and for each stage; write them into full skills on the variant
        page. A new workflow has no eval kind; use it for Live, stage tracking and analysis.
      </p>
      {create.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not create the workflow</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">
            {create.error.message}
          </AlertDescription>
        </Alert>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={!ready || create.isPending}>
          {create.isPending ? 'Creating…' : 'Create'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// Badge of an auto-imported variant (Contracts 29.1): "Latest" for the current latest release, otherwise its tag
export function ReleaseBadge({
  variant,
  latestTag,
}: {
  variant: Pick<Variant, 'releaseTag'>;
  latestTag: string | null;
}) {
  if (variant.releaseTag === null) return null;
  return (
    <Badge variant="secondary" className="shrink-0" data-testid="release-badge">
      {variant.releaseTag === latestTag ? 'Latest' : variant.releaseTag}
    </Badge>
  );
}

// A workflow's variants (Contracts 18.3): names link to the variant page
export function VariantRows({
  variants,
  latestTag,
}: {
  variants: (Variant & { boundSessions: number })[];
  // Current latest release of lfg and ic (Contracts 29.1); null for other workflows
  latestTag: string | null;
}) {
  if (variants.length === 0) {
    return <p className="text-sm text-muted-foreground">This workflow has no variants yet.</p>;
  }
  return (
    <table className="w-full text-sm" data-testid="variant-table">
      <thead className="text-left text-muted-foreground">
        <tr className="border-b">
          <th className="py-1.5 font-medium">Name</th>
          <th className="font-medium">Description</th>
          <th className="font-medium">Status</th>
          <th className="font-medium">Build</th>
          <th className="font-medium">Built at</th>
          <th className="font-medium">Bound sessions</th>
        </tr>
      </thead>
      <tbody>
        {variants.map((v) => (
          <tr key={v.id} className="border-b last:border-b-0" data-testid={`variant-row-${v.name}`}>
            <td className="py-1.5">
              <span className="flex items-center gap-1">
                <VariantName
                  variant={v}
                  link={(name) => (
                    <Link
                      className="font-medium underline-offset-4 hover:underline"
                      to={variantHref(v)}
                    >
                      {name}
                    </Link>
                  )}
                />
                <ReleaseBadge variant={v} latestTag={latestTag} />
                {/* Next to the rename pencil (Contracts 24.6); for a workflow's last variant the dialog says it cannot be deleted on its own */}
                <DeleteButton kind="variant" id={v.id} name={v.name} icon />
              </span>
            </td>
            <td className="max-w-md truncate text-muted-foreground" title={v.description ?? ''}>
              {v.description ?? ''}
            </td>
            <td>{statusLabel[v.status]}</td>
            <td>{isImported(v) ? importedLabel : buildLabel(v)}</td>
            <td>{v.builtAt === null ? '—' : formatDateTime(v.builtAt)}</td>
            <td>{v.boundSessions}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function WorkflowRow({
  workflow,
  variants,
}: {
  workflow: WorkflowRecord;
  variants: (Variant & { boundSessions: number })[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <Fragment>
      <tr className="border-b" data-testid={`workflow-row-${workflow.id}`}>
        <td className="py-2">
          <span className="flex items-center gap-1">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-expanded={open}
              aria-label={`${open ? 'Collapse' : 'Expand'} variants of ${workflow.name}`}
              onClick={() => {
                setOpen(!open);
              }}
            >
              {open ? <ChevronDown /> : <ChevronRight />}
            </Button>
            <Link
              className="font-medium underline-offset-4 hover:underline"
              to={`/workflows/${workflow.id}`}
            >
              {workflow.name}
            </Link>
            {workflow.builtin ? (
              <span className="ml-1 text-xs whitespace-nowrap text-muted-foreground">Built-in</span>
            ) : (
              <DeleteButton kind="workflow" id={workflow.id} name={workflow.name} icon />
            )}
          </span>
        </td>
        <td className="max-w-md truncate text-muted-foreground" title={workflow.description ?? ''}>
          {workflow.description ?? ''}
        </td>
        <td className="pr-4 font-mono">/{workflow.id}</td>
        <td className="pr-4 whitespace-nowrap">{evalKindLabel(workflow.evalKind)}</td>
        <td className="pr-4">{workflow.definition.stages.length}</td>
        <td>{workflow.variants}</td>
      </tr>
      {open && (
        <tr className="border-b bg-muted/30" data-testid={`workflow-variants-${workflow.id}`}>
          <td colSpan={6} className="px-8 py-2">
            <VariantRows variants={variants} latestTag={workflow.release?.tag ?? null} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// Contracts 16.7, 18.3, 22.1: the Workflows list and creation (from blank, or generated with Codex or Claude Code)
export function WorkflowsPage() {
  const list = useQuery(workflowsQuery);
  const variants = useQuery(variantsQuery);
  const [creating, setCreating] = useState<'blank' | 'codex' | null>(null);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageShell
          title="Workflows"
          description="A workflow is an entry command followed by a series of stages; a variant is one version of it. The built-in lfg and ic are read-only (except their descriptions); create new workflows from blank."
        />
        <div className="flex gap-2">
          <Button
            onClick={() => {
              setCreating('blank');
            }}
          >
            <Plus />
            New from blank
          </Button>
          <Button
            variant="outline"
            data-testid="codex-workflow-toggle"
            onClick={() => {
              setCreating('codex');
            }}
          >
            <Sparkles />
            Generate workflow
          </Button>
        </div>
      </div>
      {creating === 'blank' && (
        <BlankWorkflowForm
          onCancel={() => {
            setCreating(null);
          }}
        />
      )}
      {creating === 'codex' && (
        <CodexDraftForm
          mode="workflow"
          onCancel={() => {
            setCreating(null);
          }}
        />
      )}
      {list.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {(list.isError || variants.isError) && (
        <Alert variant="destructive">
          <AlertTitle>Could not load workflows</AlertTitle>
          <AlertDescription>{(list.error ?? variants.error)?.message}</AlertDescription>
        </Alert>
      )}
      {list.data !== undefined && (
        <table className="w-full text-sm" data-testid="workflows-table">
          <thead className="text-left text-muted-foreground">
            <tr className="border-b">
              <th className="py-2 font-medium">Name</th>
              <th className="font-medium">Description</th>
              <th className="pr-4 font-medium">Entry command</th>
              <th className="pr-4 font-medium">Eval kind</th>
              <th className="pr-4 font-medium">Stages</th>
              <th className="font-medium">Variants</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((w) => (
              <WorkflowRow
                key={w.id}
                workflow={w}
                variants={(variants.data ?? []).filter((v) => v.workflowId === w.id)}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
