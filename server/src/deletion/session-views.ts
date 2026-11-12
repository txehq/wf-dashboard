import { z } from 'zod';
import { sessionEngines } from '../db/schema.js';

// API shapes for clearing, deleting and archiving on the Sessions page (Contracts 25.1, 25.3, 25.5); web imports them directly.
// Clearing only removes a session from the management table and leaves files on disk untouched
export const sessionActions = ['clear', 'delete', 'archive', 'unarchive'] as const;
export type SessionAction = (typeof sessionActions)[number];

export const SessionActionBody = z.strictObject({ ids: z.array(z.string().min(1)).min(1) });

// Confirmation dialog content: the sessions to process and each file path (Codex rollouts are deleted by codex delete),
// the Live items deleted along with them, and the reasons for refusal
export const SessionActionPlan = z.object({
  action: z.enum(sessionActions),
  sessions: z.array(
    z.object({
      id: z.string(),
      title: z.string().nullable(),
      engine: z.enum(sessionEngines),
      files: z.array(z.string()),
    }),
  ),
  liveItems: z.array(z.object({ id: z.string(), title: z.string() })),
  blockers: z.array(z.object({ sessionId: z.string(), label: z.string() })),
});
export type SessionActionPlan = z.infer<typeof SessionActionPlan>;
