import { z } from 'zod';
import { liveEngines, magiDeployStatuses, magiDeployStepStatuses } from '../db/schema.js';

// Magi Agent API (Contracts section 23)

// Open (Contracts 23.6): config is local or a variant id; liveId is the session to continue, null for a new one
export const MagiOpenBody = z.object({
  engine: z.enum(liveEngines),
  config: z.string().min(1),
  liveId: z.string().min(1).nullable(),
});
export type MagiOpenBody = z.infer<typeof MagiOpenBody>;

export const MagiSessionView = z.object({
  id: z.string(),
  title: z.string(),
  engine: z.enum(liveEngines),
  config: z.string(),
  updatedAt: z.number(),
  running: z.boolean(),
});
export type MagiSessionView = z.infer<typeof MagiSessionView>;

// Preparation on the worktree's first open: git worktree add and pnpm install (Contracts 23.2)
export const WorktreeStep = z.object({
  id: z.enum(['worktree', 'install']),
  label: z.string(),
  status: z.enum(['pending', 'running', 'done', 'failed']),
  // The command's output as written
  output: z.string().nullable(),
});
export type WorktreeStep = z.infer<typeof WorktreeStep>;

export const MagiDeployStepView = z.object({
  id: z.string(),
  label: z.string(),
  status: z.enum(magiDeployStepStatuses),
  output: z.string().nullable(),
  startedAt: z.number().nullable(),
  endedAt: z.number().nullable(),
});

export const MagiDeployView = z.object({
  id: z.number(),
  liveId: z.string(),
  engine: z.enum(liveEngines),
  status: z.enum(magiDeployStatuses),
  steps: z.array(MagiDeployStepView),
  error: z.string().nullable(),
  commit: z.string().nullable(),
  startedAt: z.number(),
  endedAt: z.number().nullable(),
});
export type MagiDeployView = z.infer<typeof MagiDeployView>;

export const MagiAgentView = z.object({
  worktree: z.object({
    // git: a worktree of the dashboard's repository; package: the read-only sources of an installed release package
    // (Contracts 39.5), with no branch status and no deploy
    source: z.enum(['git', 'package']),
    path: z.string(),
    branch: z.string(),
    // missing: not created yet; preparing: being created or installed; ready: can start; failed: a step failed
    // (retried from the start on the next open)
    state: z.enum(['missing', 'preparing', 'ready', 'failed']),
    steps: z.array(WorktreeStep),
    // Commits ahead of and behind main, and the number of uncommitted files; null while the worktree is not ready
    ahead: z.number().nullable(),
    behind: z.number().nullable(),
    uncommitted: z.number().nullable(),
    // The error text when starting in the background after the worktree is ready fails
    startError: z.string().nullable(),
  }),
  // All Magi Agent sessions (including closed ones), newest first
  sessions: z.array(MagiSessionView),
  // The latest deploy
  deploy: MagiDeployView.nullable(),
});
export type MagiAgentView = z.infer<typeof MagiAgentView>;

export const DeployBody = z.object({ liveId: z.string().min(1) });
