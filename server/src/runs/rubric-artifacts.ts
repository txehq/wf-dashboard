import fs from 'node:fs';
import type { Db } from '../db/index.js';
import { ArtifactTracker } from '../stages/artifacts.js';
import type { RubricArtifactSpec } from '../workflows/schema.js';
import { upsertArtifact } from './records.js';

// Artifact records for rubric grading (Contracts 7.2, 16.2): when an artifact file appears, its path and content snapshot are written; lockedPlan artifacts
// get the snapshot at lock time. The runner calls record() on new session writes, at turn end and at run end: artifacts are written by the agent's tool calls,
// whose results then land in the jsonl, so the feature directory needs no separate watcher
export class RubricArtifacts {
  private readonly tracker: ArtifactTracker;
  private readonly locked = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly runId: string,
    featureDir: string,
    private readonly specs: RubricArtifactSpec[],
  ) {
    this.tracker = new ArtifactTracker(featureDir, runId, specs);
  }

  record() {
    const docs = this.tracker.observe();
    for (const spec of this.specs) {
      if (spec.lockedPlan === true && docs.get(spec.id)) this.locked.add(spec.id);
    }
    // After locking, other artifacts sharing candidate files with a locked one keep their pre-lock snapshot (Research.md content after lock belongs to plan)
    const lockedFiles = new Set(
      this.specs.filter((s) => this.locked.has(s.id)).flatMap((s) => s.files.map((f) => f.file)),
    );
    for (const spec of this.specs) {
      const doc = docs.get(spec.id) ?? null;
      if (doc === null) continue;
      if (spec.lockedPlan !== true && spec.files.some((f) => lockedFiles.has(f.file))) continue;
      upsertArtifact(this.db, this.runId, spec.id, doc.path, fs.readFileSync(doc.path, 'utf8'));
    }
  }
}
