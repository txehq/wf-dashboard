import { z } from 'zod';
import type { Db } from '../db/index.js';
import { artifacts, type runs } from '../db/schema.js';
import { PrSnapshot, readPrSnapshot } from '../external/github.js';

type Run = typeof runs.$inferSelect;

// artifacts.snapshot 的内容：快照时间与 PR（仓库中还没有 PR 时为 null）
export const StoredPrSnapshot = z.object({
  capturedAt: z.iso.datetime(),
  pr: PrSnapshot.nullable(),
});
export type StoredPrSnapshot = z.infer<typeof StoredPrSnapshot>;

export const repoUrl = (repo: string) => `https://github.com/${repo}`;

// run 进入 grading 时：PR 的 reviews、review thread、评论与 checks 存进 artifacts（kind pr_snapshot，Contracts 15.2）
export async function recordPrSnapshot(db: Db, run: Run): Promise<void> {
  if (run.githubRepo === null) return;
  storePrSnapshot(db, run.id, run.githubRepo, await readPrSnapshot(run.githubRepo));
}

export function storePrSnapshot(db: Db, runId: string, repo: string, pr: PrSnapshot | null) {
  const stored: StoredPrSnapshot = { capturedAt: new Date().toISOString(), pr };
  const now = new Date();
  db.insert(artifacts)
    .values({
      runId,
      kind: 'pr_snapshot',
      location: repoUrl(repo),
      snapshot: JSON.stringify(stored),
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [artifacts.runId, artifacts.kind, artifacts.location],
      set: { snapshot: JSON.stringify(stored), updatedAt: now },
    })
    .run();
}
