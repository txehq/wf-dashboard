import fs from 'node:fs';
import type { Db } from '../db/index.js';
import { ArtifactTracker } from '../stages/artifacts.js';
import type { RubricArtifactSpec } from '../workflows/schema.js';
import { upsertArtifact } from './records.js';

// rubric 评分的产物记录（Contracts 7.2、16.2）：产物文件出现时写入路径与内容快照，lockedPlan 的产物在锁定时写入
// 锁定后的快照。runner 在 session 有新写入、一轮结束与 run 结束时调用 record()：产物由 agent 的 tool 调用写出，
// 调用的结果随后写入 jsonl，因此不需要另外监听 feature 目录
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
    // 锁定之后，与锁定的产物共用候选文件的其他产物保留锁定前的快照（Research.md 锁定后的内容归 plan）
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
