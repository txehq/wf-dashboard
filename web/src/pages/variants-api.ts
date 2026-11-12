import { type QueryClient, queryOptions } from '@tanstack/react-query';
import { requestJson } from '@/lib/http';

export interface Variant {
  id: string;
  name: string;
  // Description (Contracts 18.3)
  description: string | null;
  // Owning workflow (Contracts 16.4)
  workflowId: string;
  parentId: string | null;
  // A variant of a custom workflow has only one set of skills and no base: empty string (Contracts 18.6)
  baseCommit: string;
  skillsHash: string;
  version: string;
  status: 'draft' | 'frozen';
  // Variants imported from another data directory have no install directory
  installDir: string | null;
  // Directory shared with another variant (lfg and ic split by migration, Contracts 16.4); null means its own
  storageId: string | null;
  buildStatus: 'none' | 'building' | 'built' | 'failed';
  builtHash: string | null;
  buildError: string | null;
  builtAt: string | null;
  createdAt: string;
  frozenAt: string | null;
  // Analysis id when created by an analysis's "Save as variant"; source session when created from a session's skills
  analysisId: string | null;
  sourceSessionId: string | null;
  // Draft id when saved from a draft (Contracts 17.4)
  draftId: string | null;
  // Deletion time (Contracts 24.3): deleted variants keep only their name for display and leave lists and pickers
  deletedAt: string | null;
  // Tag of the auto-imported txe-workflow release (Contracts 29.1); null otherwise
  releaseTag: string | null;
  // "Include Orca skills" (Contracts 35.5) and the Orca version the latest build included
  orcaSkills: boolean;
  orcaVersion: string | null;
}

export interface VariantOptions {
  models: { alias: string; model: string }[];
  efforts: string[];
}

export interface SkillFile {
  path: string;
  size: number;
}

export interface FileDiff {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldContent: string;
  newContent: string;
  patch: string;
}

export interface VariantDiff {
  against: { kind: 'parent' | 'base'; variantId: string | null; commit: string };
  files: FileDiff[];
}

export const statusLabel: Record<Variant['status'], string> = { draft: 'Draft', frozen: 'Frozen' };

// A variant's name on pages: name (workflow), e.g. Base (lfg); deleted ones are name (deleted) (workflow)
export const variantLabel = (
  variant: Pick<Variant, 'name' | 'workflowId'> & { deletedAt?: string | null },
) =>
  `${variant.name}${variant.deletedAt === undefined || variant.deletedAt === null ? '' : ' (deleted)'} (${variant.workflowId})`;

// All variants, including deleted ones (Compare shows their kept runs, Contracts 24.3)
export const allVariantsQuery = queryOptions({
  queryKey: ['variants', 'with-deleted'],
  queryFn: () =>
    request<(Variant & { boundSessions: number })[]>('GET', '/api/variants?includeDeleted=1'),
});

// The variant's own page (Contracts 18.3)
export const variantHref = (variant: Pick<Variant, 'id'>) => `/variants/${variant.id}`;

// Manifest of a local install (Contracts 18.6)
export interface InstallManifest {
  variantId: string;
  variantName: string;
  workflowId: string;
  installedAt: number;
  targets: { claude: string; agents: string };
  dirs: string[];
  files: { path: string; sha256: string }[];
}

// Built from the current content and ready to run
export function isBuilt(v: Pick<Variant, 'buildStatus' | 'builtHash' | 'skillsHash'>): boolean {
  return v.buildStatus === 'built' && v.builtHash === v.skillsHash;
}

export function buildLabel(variant: Variant): string {
  // Built, then edited (the server resets buildStatus to none; builtHash still holds the last build)
  if (
    (variant.buildStatus === 'built' || variant.buildStatus === 'none') &&
    variant.builtHash !== null &&
    variant.builtHash !== variant.skillsHash
  ) {
    return 'Needs rebuild';
  }
  return { none: 'Not built', building: 'Building', built: 'Built', failed: 'Build failed' }[
    variant.buildStatus
  ];
}

// On failure throws an error with the URL, status code and the server's reason
export async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  return (await requestJson(method, url, body)) as T;
}

// After a failure nothing re-requests automatically (retry, window focus, reconnect, remount); the page's Retry does
const notFailed = (query: { state: { status: string } }) => query.state.status !== 'error';
const manualRetry = {
  retry: false,
  retryOnMount: false,
  refetchOnWindowFocus: notFailed,
  refetchOnReconnect: notFailed,
} as const;

// Variants imported from another data directory: skills content only, cannot be edited, built or run
export function isImported(variant: Variant): boolean {
  return variant.installDir === null;
}

export const importedLabel = 'Imported variant (read-only; derive one to build and run)';

export const variantsQuery = queryOptions({
  queryKey: ['variants'],
  // Each listed variant also carries its bound session count
  queryFn: () => request<(Variant & { boundSessions: number })[]>('GET', '/api/variants'),
  ...manualRetry,
});

export const variantOptionsQuery = queryOptions({
  queryKey: ['variants', 'options'],
  queryFn: () => request<VariantOptions>('GET', '/api/variants/options'),
  staleTime: Infinity,
  ...manualRetry,
});

export const variantQuery = (id: string) =>
  queryOptions({
    queryKey: ['variants', id],
    queryFn: () => request<Variant>('GET', `/api/variants/${id}`),
    ...manualRetry,
  });

export const filesQuery = (id: string) =>
  queryOptions({
    queryKey: ['variants', id, 'files'],
    queryFn: () => request<SkillFile[]>('GET', `/api/variants/${id}/files`),
    ...manualRetry,
  });

export const fileQuery = (id: string, path: string) =>
  queryOptions({
    queryKey: ['variants', id, 'file', path],
    queryFn: () =>
      request<{ path: string; content: string }>(
        'GET',
        `/api/variants/${id}/file?path=${encodeURIComponent(path)}`,
      ),
    staleTime: Infinity,
    ...manualRetry,
  });

export const diffQuery = (id: string, against: 'base' | 'parent') =>
  queryOptions({
    queryKey: ['variants', id, 'diff', against],
    queryFn: () => request<VariantDiff>('GET', `/api/variants/${id}/diff?against=${against}`),
    ...manualRetry,
  });

export const buildLogQuery = (id: string, building: boolean) =>
  queryOptions({
    queryKey: ['variants', id, 'build-log'],
    queryFn: () => request<string>('GET', `/api/variants/${id}/build-log`),
    ...manualRetry,
    refetchInterval: (query) => (building && notFailed(query) ? 1000 : false),
  });

// Re-read the build log when a build starts or ends. If the panel just opened and the first read has not
// answered yet, TanStack Query's invalidate reuses that in-flight read, which may return the log from before
// the build ended: cancel it first, then read
export async function refetchBuildLog(client: QueryClient, id: string) {
  const { queryKey } = buildLogQuery(id, false);
  await client.cancelQueries({ queryKey, exact: true });
  await client.invalidateQueries({ queryKey, exact: true });
}

// One variant history entry (Contracts 16.4, 17.4): a rename, or the previous src/ kept when a draft overwrote
// it or a restore happened. draftEngine is the draft's engine (28.4); null when the draft was deleted and the
// overwrite did not record it
export type HistoryEntry = { id: number; at: number } & (
  | { kind: 'rename'; from: string; to: string }
  | {
      kind: 'overwrite';
      snapshot: string;
      draftId: string;
      draftEngine: 'claude' | 'codex' | null;
      analysisId: string | null;
    }
  | { kind: 'restore'; snapshot: string; restoredEventId: number }
);

export const historyQuery = (id: string) =>
  queryOptions({
    queryKey: ['variants', id, 'history'],
    queryFn: () => request<HistoryEntry[]>('GET', `/api/variants/${id}/history`),
    ...manualRetry,
  });

// A src/ kept in history: per-file changes if the current content were restored to it
export const historyDiffQuery = (id: string, eventId: number) =>
  queryOptions({
    queryKey: ['variants', id, 'history', eventId, 'diff'],
    queryFn: () =>
      request<FileDiff[]>('GET', `/api/variants/${id}/history/${String(eventId)}/diff`),
    staleTime: 0,
    ...manualRetry,
  });

export const installQuery = (id: string) =>
  queryOptions({
    queryKey: ['variants', id, 'install'],
    queryFn: () =>
      request<{ installed: InstallManifest | null }>('GET', `/api/variants/${id}/install`),
    ...manualRetry,
  });
