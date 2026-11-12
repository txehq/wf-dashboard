import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, GitBranchPlus, Hammer, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { useFullscreen } from '@/components/fullscreen';
import { VariantName } from '@/components/variant-name';
import { OrcaSkillsSwitch } from '@/components/variant-orca';
import { OpenInFinder } from '@/components/open-in-finder';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DeleteButton } from '@/components/delete-dialog';
import { VariantHistoryButton } from '@/components/variant-history';
import { draftQuery } from '@/lib/drafts-api';
import { engineNames } from '@/lib/engine-names';
import { formatDateTime } from '@/lib/format';
import { type WorkflowRecord, workflowsQuery } from '@/lib/workflows-api';
import { VariantWorkspace } from '@/pages/variant-workspace';
import {
  buildLabel,
  importedLabel,
  type InstallManifest,
  installQuery,
  isImported,
  refetchBuildLog,
  request,
  statusLabel,
  type Variant,
  variantHref,
  variantLabel,
  variantQuery,
} from '@/pages/variants-api';
import { QueryError } from '@/pages/variants-error';

// /variants has no page of its own (Contracts 16.7): variants are reached from the Workflows list and workflow pages
export function VariantsRedirect() {
  return <Navigate to="/workflows" replace />;
}

// Header actions (Contracts 20.2): build, derive a new variant, open in Finder, install locally. The caller shows errors
function useVariantActions(variant: Variant, onBuildStart: () => void) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['variants'] });
  };
  const build = useMutation({
    mutationFn: () => request<Variant>('POST', `/api/variants/${variant.id}/build`),
    onMutate: onBuildStart,
    onSettled: async () => {
      await refetchBuildLog(client, variant.id);
      await refresh();
    },
  });
  const derive = useMutation({
    mutationFn: (name: string) =>
      request<Variant>('POST', `/api/variants/${variant.id}/derive`, { name }),
    onSuccess: async (created) => {
      await refresh();
      await navigate(variantHref(created));
    },
  });
  const install = useMutation({
    mutationFn: () =>
      request<{ installed: InstallManifest; replaced: InstallManifest[] }>(
        'POST',
        `/api/variants/${variant.id}/install`,
      ),
    onSuccess: refresh,
  });
  const uninstall = useMutation({
    mutationFn: () => request('DELETE', `/api/variants/${variant.id}/install`),
    onSuccess: refresh,
  });
  return { build, derive, install, uninstall };
}

function HeaderActions({
  variant,
  workflow,
  actions,
  installed,
}: {
  variant: Variant;
  workflow: WorkflowRecord;
  actions: ReturnType<typeof useVariantActions>;
  installed: InstallManifest | null | undefined;
}) {
  const { build, derive, install, uninstall } = actions;
  const frozen = variant.status === 'frozen';
  const imported = isImported(variant);
  const building = build.isPending || variant.buildStatus === 'building';
  const built = variant.buildStatus === 'built' && variant.builtHash === variant.skillsHash;
  return (
    <div className="ml-auto flex flex-wrap items-center gap-2" data-testid="variant-actions">
      {!frozen && !imported && (
        <Button
          size="sm"
          disabled={building}
          onClick={() => {
            build.mutate();
          }}
        >
          <Hammer />
          {building ? 'Building…' : 'Build'}
        </Button>
      )}
      <Button
        size="sm"
        variant={frozen || imported ? 'default' : 'outline'}
        disabled={derive.isPending}
        title="Copy this variant into a new draft in the same workflow"
        onClick={() => {
          const name = window.prompt(
            'New variant name',
            imported ? `${variant.name} (runnable)` : `${variant.name} copy`,
          );
          if (name !== null && name.trim() !== '') derive.mutate(name.trim());
        }}
      >
        <GitBranchPlus />
        {imported ? 'Derive runnable variant' : 'Derive new variant'}
      </Button>
      <OpenInFinder target={{ kind: 'variant', id: variant.id }} label="Open in Finder" />
      <VariantHistoryButton variant={variant} />
      <DeleteButton
        kind="variant"
        id={variant.id}
        name={variant.name}
        after={`/workflows/${workflow.id}`}
      />
      {/* Local install only for workflows not managed by wf (Contracts 18.6) */}
      {!workflow.wf && (
        <span className="contents" data-testid="local-install">
          {installed === null || installed === undefined ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!built || install.isPending || installed === undefined}
              title={
                built
                  ? 'Copy the skills into ~/.claude/skills and ~/.agents/skills; one variant per workflow is installed at a time'
                  : 'Build the current content before installing'
              }
              onClick={() => {
                install.mutate();
              }}
            >
              <Download />
              {install.isPending ? 'Installing…' : 'Install locally'}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={uninstall.isPending}
              title={`Installed in:\n${installed.dirs.join('\n')}`}
              onClick={() => {
                uninstall.mutate();
              }}
            >
              <Trash2 />
              {uninstall.isPending ? 'Uninstalling…' : 'Uninstall'}
            </Button>
          )}
        </span>
      )}
    </div>
  );
}

// Status, version and origin on one line
function StatusLine({
  variant,
  workflow,
  installed,
}: {
  variant: Variant;
  workflow: WorkflowRecord;
  installed: InstallManifest | null | undefined;
}) {
  const imported = isImported(variant);
  const parent = useQuery({
    ...variantQuery(variant.parentId ?? ''),
    enabled: variant.parentId !== null,
  });
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
      <span className="rounded-md border px-2 py-0.5 text-xs text-foreground">
        {statusLabel[variant.status]}
      </span>
      <span
        className="rounded-md border px-2 py-0.5 text-xs text-foreground"
        data-testid="build-status"
      >
        {imported ? importedLabel : buildLabel(variant)}
      </span>
      <span className="font-mono text-xs" data-testid="variant-version">
        {variant.version}
        {variant.baseCommit !== '' && ` · base ${variant.baseCommit.slice(0, 7)}`}
      </span>
      <OrcaSkillsSwitch variant={variant} locked={variant.status === 'frozen' || imported} />
      {!workflow.wf && (
        <span data-testid="local-install-status" title={installed?.dirs.join('\n')}>
          {installed === undefined
            ? 'Checking install…'
            : installed === null
              ? 'Not installed locally'
              : `Installed locally (${formatDateTime(new Date(installed.installedAt).toISOString())})`}
        </span>
      )}
      {variant.parentId !== null && (
        <span data-testid="variant-parent">
          Derived from{' '}
          {parent.data === undefined ? (
            variant.parentId
          ) : parent.data.deletedAt !== null ? (
            // A deleted parent shows only its name, with no link (Contracts 24.3)
            variantLabel(parent.data)
          ) : (
            <Link className="underline" to={variantHref(parent.data)}>
              {variantLabel(parent.data)}
            </Link>
          )}
          {parent.data !== undefined && isImported(parent.data) && ' (imported variant)'}
        </span>
      )}
      {variant.storageId !== null && (
        <span data-testid="variant-shared">
          Shares its directory with the same-named variant of another workflow
        </span>
      )}
      {variant.analysisId !== null && (
        <span data-testid="variant-analysis">
          From analysis{' '}
          <Link className="font-mono underline" to={`/analyses/${variant.analysisId}`}>
            {variant.analysisId}
          </Link>
        </span>
      )}
      {variant.sourceSessionId !== null && (
        <span data-testid="variant-source-session">
          Created from the skills of session{' '}
          <Link className="font-mono underline" to={`/sessions/${variant.sourceSessionId}`}>
            {variant.sourceSessionId.slice(0, 8)}
          </Link>
        </span>
      )}
      {variant.draftId !== null && <DraftSource draftId={variant.draftId} />}
      {variant.status === 'frozen' && !imported && <span>Used by a run; content is read-only</span>}
    </div>
  );
}

// The draft this variant was saved from (Contracts 17.4, 28.4), named by its engine. A draft a variant points
// to is deleted only together with its workflow
function DraftSource({ draftId }: { draftId: string }) {
  const draft = useQuery(draftQuery(draftId));
  if (draft.data === undefined) return null;
  return (
    <span data-testid="variant-draft">
      From {engineNames[draft.data.engine]} draft <span className="font-mono">{draftId}</span>
    </span>
  );
}

// Description (Contracts 18.3): input and save button on one line
function DescriptionLine({ variant }: { variant: Variant }) {
  const client = useQueryClient();
  const [text, setText] = useState(variant.description ?? '');
  const save = useMutation({
    mutationFn: () => request('PATCH', `/api/variants/${variant.id}`, { description: text }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['variants'] });
    },
  });
  const changed = text.trim() !== (variant.description ?? '').trim();
  return (
    <div className="flex items-center gap-2 text-sm" data-testid="description-editor">
      <input
        className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2"
        aria-label="Description"
        placeholder="One line on what this does"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && changed) save.mutate();
        }}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={!changed || save.isPending}
        onClick={() => {
          save.mutate();
        }}
      >
        <Save />
        {save.isPending ? 'Saving…' : 'Save description'}
      </Button>
      {save.isSuccess && !changed && (
        <span className="text-xs text-muted-foreground" data-testid="description-saved">
          Saved
        </span>
      )}
      {save.isError && <span className="text-destructive">{save.error.message}</span>}
    </div>
  );
}

function VariantBody({ variant, workflow }: { variant: Variant; workflow: WorkflowRecord }) {
  const fullscreen = useFullscreen();
  const [logOpen, setLogOpen] = useState(false);
  const actions = useVariantActions(variant, () => {
    setLogOpen(true);
  });
  const install = useQuery({ ...installQuery(variant.id), enabled: !workflow.wf });
  const installed = install.data?.installed;
  const building = actions.build.isPending || variant.buildStatus === 'building';
  const error =
    actions.build.error ??
    actions.derive.error ??
    actions.install.error ??
    actions.uninstall.error ??
    install.error;
  return (
    <div className="flex flex-col gap-3" data-testid="variant-panel">
      {/* Header row: breadcrumb and name on the left, actions on the right */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <nav
          aria-label="Breadcrumb"
          className="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground"
          data-testid="breadcrumb"
        >
          <Link className="shrink-0 underline-offset-4 hover:underline" to="/workflows">
            Workflows
          </Link>
          {' › '}
          <Link
            className="shrink-0 underline-offset-4 hover:underline"
            to={`/workflows/${workflow.id}`}
          >
            {workflow.name}
          </Link>
          {' › '}
          <h1 className="min-w-0 text-xl font-semibold text-foreground">
            <VariantName variant={variant} className="truncate" />
          </h1>
        </nav>
        <HeaderActions
          variant={variant}
          workflow={workflow}
          actions={actions}
          installed={installed}
        />
      </div>
      <StatusLine variant={variant} workflow={workflow} installed={installed} />
      {variant.buildStatus === 'failed' && variant.buildError !== null && (
        <p className="text-sm text-destructive" data-testid="build-error">
          Build failed: {variant.buildError}
        </p>
      )}
      {actions.install.data !== undefined && actions.install.data.replaced.length > 0 && (
        <p className="text-sm text-muted-foreground">
          Uninstalled first from the same workflow:{' '}
          {actions.install.data.replaced.map((m) => m.variantName).join(', ')}.
        </p>
      )}
      {error !== null && (
        <Alert variant="destructive">
          <AlertTitle>Action failed</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">{error.message}</AlertDescription>
        </Alert>
      )}
      {/* VariantBody remounts per variant id, so this state resets with it */}
      <DescriptionLine variant={variant} />
      <VariantWorkspace
        variant={variant}
        fullscreen={fullscreen}
        building={building}
        logOpen={logOpen}
        onLogOpen={setLogOpen}
      />
    </div>
  );
}

// The variant's own page (Contracts 18.3, 20.2)
export function VariantPage() {
  const { id } = useParams();
  if (id === undefined) throw new Error('Route is missing the variant id');
  const variant = useQuery(variantQuery(id));
  const workflows = useQuery(workflowsQuery);
  if (variant.isPending || workflows.isPending) {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  if (variant.isError) {
    return (
      <QueryError
        error={variant.error}
        retrying={variant.isFetching}
        onRetry={() => void variant.refetch()}
      />
    );
  }
  if (workflows.isError) {
    return <p className="text-sm text-destructive">{workflows.error.message}</p>;
  }
  // A deleted variant (Contracts 24.3) keeps only its name; the page offers no editing or actions
  if (variant.data.deletedAt !== null) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="variant-deleted">
        Variant {variantLabel(variant.data)} was deleted.
        <Link className="ml-2 underline" to="/workflows">
          Back to Workflows
        </Link>
      </p>
    );
  }
  const workflow = workflows.data.find((w) => w.id === variant.data.workflowId);
  if (workflow === undefined) throw new Error(`No workflow ${variant.data.workflowId}`);
  return <VariantBody key={variant.data.id} variant={variant.data} workflow={workflow} />;
}
