import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Save } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { DraftProgress } from '@/components/codex-draft';
import { CodexSaveDialog } from '@/components/codex-save-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { type Draft, draftQuery, resumeDraft, retryDraft } from '@/lib/drafts-api';
import type { LiveDetail } from '@/lib/live-api';
import { invalidateThrottled, useLiveEvent } from '@/lib/live-events';
import { variantHref, variantLabel } from '@/pages/variants-api';

// What design and optimize sessions in Live add over interaction items (Contracts 17.4, 22, 26.1),
// placed in the shared toolbar: resume (continue the draft's session), save, the draft and analysis
// on the line below, and under the toolbar the preparation progress, links to saved results and raw
// errors; same for Codex and Claude Code
export interface DraftControls {
  draft: Draft | undefined;
  resume: ReactNode;
  save: ReactNode;
  meta: ReactNode;
  below: ReactNode;
}

export function useDraftControls(
  live: LiveDetail,
  onResumed: (live: LiveDetail) => void,
): DraftControls {
  const client = useQueryClient();
  const draftId = live.draftId;
  const draft = useQuery({ ...draftQuery(draftId ?? ''), enabled: draftId !== null });
  const resume = useMutation({ mutationFn: () => resumeDraft(live.id), onSuccess: onResumed });
  // Save dialog (Contracts 17.4): destination, name and description, changes to be saved
  const [saving, setSaving] = useState(false);
  const retry = useMutation({
    mutationFn: () => retryDraft(draftId ?? ''),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['drafts'] });
    },
  });
  // Preparation progress and status (Contracts 17.1)
  useLiveEvent((type) => {
    if (type === 'draft.updated') invalidateThrottled(client, ['drafts'], 300);
  });
  const d = draft.data;
  const savable = d?.status === 'open' || d?.status === 'saved';
  const save = draftId !== null && (
    <>
      <Button
        size="sm"
        data-testid="codex-draft-save"
        disabled={!savable}
        title="Create a variant or overwrite an existing one; saving does not build"
        onClick={() => {
          setSaving(true);
        }}
      >
        <Save />
        Save
      </Button>
      {saving && d !== undefined && (
        <CodexSaveDialog
          draft={d}
          onClose={() => {
            setSaving(false);
          }}
        />
      )}
    </>
  );
  const meta =
    draftId === null ? (
      <span>No draft linked to this session</span>
    ) : (
      <>
        <span data-testid="codex-draft-id">
          Draft <span className="font-mono">{draftId}</span>
        </span>
        {d?.analysisId != null && (
          <Link
            className="underline"
            to={`/analyses/${d.analysisId}`}
            data-testid="codex-draft-analysis"
          >
            Analysis {d.analysisId}
          </Link>
        )}
      </>
    );
  const resumeButton = live.status !== 'running' && live.process !== null && (
    <Button
      size="sm"
      variant="outline"
      data-testid="codex-resume"
      title="resume"
      disabled={resume.isPending}
      onClick={() => {
        resume.mutate();
      }}
    >
      <Play />
      <span data-toolbar-label>Resume</span>
    </Button>
  );
  const below = (
    <>
      {d !== undefined && (d.status === 'preparing' || d.status === 'failed') && (
        <DraftProgress
          draft={d}
          retrying={retry.isPending}
          onRetry={() => {
            retry.mutate();
          }}
        />
      )}
      {d !== undefined && d.savedVariants.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-2 text-sm" data-testid="codex-draft-saved">
          Saved:
          {d.mode !== 'variant' &&
            d.savedWorkflowId !== null &&
            (d.mode === 'workflow' || d.savedWorkflowId !== d.workflowId) && (
              <Link className="underline" to={`/workflows/${d.savedWorkflowId}`}>
                workflow /{d.savedWorkflowId}
              </Link>
            )}
          {d.savedVariants.map((v) =>
            // Deleted ones show only the name (the server adds the deleted marker, Contracts 24.3)
            v.deleted ? (
              <span key={v.id}>{variantLabel(v)}</span>
            ) : (
              <Link key={v.id} className="underline" to={variantHref(v)}>
                {variantLabel(v)}
              </Link>
            ),
          )}
        </p>
      )}
      {(resume.isError || retry.isError || draft.isError) && (
        <Alert variant="destructive" data-testid="codex-draft-error">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription className="max-h-80 overflow-auto font-mono text-xs whitespace-pre-wrap">
            {(resume.error ?? retry.error ?? draft.error)?.message}
          </AlertDescription>
        </Alert>
      )}
    </>
  );
  return { draft: d, resume: resumeButton, save, meta, below };
}
