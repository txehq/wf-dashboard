import { z } from 'zod';
import type { Db } from '../db/index.js';
import { artifacts, type runs } from '../db/schema.js';
import { PrSnapshot, readPrSnapshot } from '../external/github.js';
import { repoLocation } from '../external/run-repos.js';

type Run = typeof runs.$inferSelect;

// Content of artifacts.snapshot: capture time and the PR (null while the repo has no PR yet)
export const StoredPrSnapshot = z.object({
  capturedAt: z.iso.datetime(),
  pr: PrSnapshot.nullable(),
});
export type StoredPrSnapshot = z.infer<typeof StoredPrSnapshot>;

// When a run enters grading: store the PR's reviews, review threads, comments and checks in artifacts (kind pr_snapshot, Contracts 15.2)
export async function recordPrSnapshot(db: Db, run: Run): Promise<void> {
  if (run.githubRepo === null) return;
  const repo = run.githubRepo;
  storePrSnapshot(db, run.id, repo, await readPrSnapshot(repo));
}

export function storePrSnapshot(db: Db, runId: string, repo: string, pr: PrSnapshot | null) {
  const stored: StoredPrSnapshot = { capturedAt: new Date().toISOString(), pr };
  const now = new Date();
  db.insert(artifacts)
    .values({
      runId,
      kind: 'pr_snapshot',
      location: repoLocation(repo),
      snapshot: JSON.stringify(stored),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [artifacts.runId, artifacts.kind, artifacts.location],
      set: { snapshot: JSON.stringify(stored), updatedAt: now },
    })
    .run();
}
