import { z } from 'zod';

// GET /api/install (Contracts 39.4): from a git checkout only installed false; from an installed release package its
// version and the state of the self-update
export const UpdateView = z.object({
  // What the update is doing now; null between checks
  step: z.enum(['checking', 'downloading', 'verifying']).nullable(),
  checkedAt: z.number().nullable(),
  // The version of the latest Release, as last read
  latest: z.string().nullable(),
  // A newer version downloaded and verified under app/, waiting to be switched to
  pending: z.string().nullable(),
  // Why the pending version is not switched to yet: the running runs and local interactive processes
  waitingFor: z.array(z.string()),
  // The last failure (reading the Release, downloading, extracting, loading native modules), as written
  error: z.string().nullable(),
});
export type UpdateView = z.infer<typeof UpdateView>;

export const InstallView = z.discriminatedUnion('installed', [
  z.object({ installed: z.literal(false) }),
  z.object({
    installed: z.literal(true),
    version: z.string(),
    commit: z.string(),
    root: z.string(),
    dataDir: z.string(),
    update: UpdateView,
  }),
]);
export type InstallView = z.infer<typeof InstallView>;
