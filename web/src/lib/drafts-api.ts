import { queryOptions } from '@tanstack/react-query';
import {
  type CreateDraftBody,
  DraftDiffView,
  type DraftEngine,
  type DraftStepView,
  DraftView,
  type SaveDraftBody,
  SavePlanView,
  SessionVariantsView,
} from '@wf-dashboard/server/drafts/views';
import type { LiveDetail } from '@/lib/live-api';
import { requestJson } from '@/lib/http';

// Matches the API of Contracts section 17, 19.3 and 22 (generating a workflow or variant, analysis optimization, with Codex or Claude Code as the engine)
export type { CreateDraftBody, DraftEngine, DraftStepView, SaveDraftBody };
export type Draft = DraftView;
export type SavePlan = SavePlanView;

export const draftQuery = (id: string) =>
  queryOptions({
    queryKey: ['drafts', id],
    queryFn: async () => DraftView.parse(await requestJson('GET', `/api/workflow-drafts/${id}`)),
  });

// The workflow-design and workflow-optimize variants selectable in the start dialog (Contracts 33.2); baseline by default
export const sessionVariantsQuery = queryOptions({
  queryKey: ['drafts', 'session-variants'],
  queryFn: async () =>
    SessionVariantsView.parse(await requestJson('GET', '/api/workflow-drafts/session-variants')),
});

// Start: the server creates the draft directory, adds the chosen variant's skills and creates a Live session; returns the draft and the item
export async function createDraft(
  body: CreateDraftBody,
): Promise<{ draft: Draft; live: LiveDetail }> {
  return (await requestJson('POST', '/api/workflow-drafts', body)) as {
    draft: Draft;
    live: LiveDetail;
  };
}

// Preview of changes before saving (Contracts 17.4, 21.3): against the variant being overwritten (against), or the
// base when omitted. Reloaded on every open, since Codex may have just changed files
export const draftDiffQuery = (id: string, against: string | null) =>
  queryOptions({
    queryKey: ['drafts', id, 'diff', against],
    queryFn: async () =>
      DraftDiffView.parse(
        await requestJson(
          'GET',
          `/api/workflow-drafts/${id}/diff${against === null ? '' : `?against=${encodeURIComponent(against)}`}`,
        ),
      ),
    staleTime: 0,
    gcTime: 0,
  });

// Save dialog content: prefill for a new workflow, or the variants of the same workflow that can be overwritten; an
// invalid workflow.yaml fails with the raw error
export const savePlanQuery = (id: string) =>
  queryOptions({
    queryKey: ['drafts', id, 'save-plan'],
    queryFn: async () =>
      SavePlanView.parse(await requestJson('GET', `/api/workflow-drafts/${id}/save-plan`)),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

// Save: a new variant or overwrite an existing one, without building; validation failures come back as the server's raw error
export async function saveDraft(id: string, body: SaveDraftBody): Promise<Draft> {
  return DraftView.parse(await requestJson('POST', `/api/workflow-drafts/${id}/save`, body));
}

// Resume a design or analysis optimization session (Contracts 17.3, 22.2): codex resume or claude --resume, continuing the same session
export async function resumeDraft(liveId: string): Promise<LiveDetail> {
  return (await requestJson('POST', `/api/live/${liveId}/draft-resume`)) as LiveDetail;
}

// Retry preparation: continue from the step that failed (Contracts 17.1)
export async function retryDraft(id: string): Promise<Draft> {
  return DraftView.parse(await requestJson('POST', `/api/workflow-drafts/${id}/retry`));
}
