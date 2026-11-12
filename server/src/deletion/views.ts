import { z } from 'zod';

// API shapes for deleting variants and workflows (Contracts section 24); web imports them directly

// Associated sessions (24.2): delete together, or rebind to another variant (null means local config, unbound)
export const SessionsChoice = z.union([
  z.literal('delete'),
  z.strictObject({ rebindTo: z.string().min(1).nullable() }),
]);
export type SessionsChoice = z.infer<typeof SessionsChoice>;

export const DeleteBody = z.strictObject({ sessions: SessionsChoice });
export type DeleteBody = z.infer<typeof DeleteBody>;

// One thing blocking deletion (24.1): built-in workflow, last variant, running users, modified local installs
export const DeletionBlocker = z.object({
  kind: z.enum(['builtin', 'last-variant', 'run', 'live', 'analysis', 'draft', 'install']),
  id: z.string(),
  label: z.string(),
});
export type DeletionBlocker = z.infer<typeof DeletionBlocker>;

// Delete dialog content (24.6)
export const DeletionPlan = z.object({
  target: z.object({
    kind: z.enum(['variant', 'workflow']),
    id: z.string(),
    name: z.string(),
    workflowId: z.string(),
  }),
  variants: z.array(z.object({ id: z.string(), name: z.string() })),
  blockers: z.array(DeletionBlocker),
  // Directories to delete (variant directories and their pre-overwrite archives, draft directories, or the optimisation part of analysis directories)
  dirs: z.array(z.string()),
  // Installed on this machine; uninstalled by manifest before deletion
  installs: z.array(z.object({ variantId: z.string(), dirs: z.array(z.string()) })),
  // Associated sessions (run sessions excluded, kept with their runs): delete together also deletes these files and Live items.
  // agent: how many are local-config Magi Agent sessions (Contracts 23.6); they and their Live items are not deleted and switch
  // to local config on delete together. Live items of Magi Agents configured with these variants count in liveItems
  sessions: z.object({
    count: z.number(),
    files: z.array(z.string()),
    liveItems: z.array(z.object({ id: z.string(), title: z.string() })),
    agent: z.number(),
  }),
  // Retained records, shown as "<name> (deleted)"
  retained: z.object({
    runs: z.number(),
    runSessions: z.number(),
    analyses: z.number(),
    liveItems: z.number(),
    children: z.array(z.object({ id: z.string(), name: z.string() })),
    drafts: z.number(),
  }),
  // Drafts deleted along with a workflow (24.5)
  drafts: z.array(z.object({ id: z.string(), liveId: z.string().nullable() })),
});
export type DeletionPlan = z.infer<typeof DeletionPlan>;
