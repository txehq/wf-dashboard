import fs from 'node:fs';
import type { Db } from '../db/index.js';
import { LfgTracker } from '../stages/lfg.js';
import { upsertArtifact } from './records.js';

// lfg run 的产物记录（Contracts 7.2）：Brief、Research、Tickets 在文件出现时写入路径与内容快照，
// plan 锁定时写入锁定后的快照。runner 在 session 有新写入、一轮结束与 run 结束时调用 record()：
// 产物由 agent 的 tool 调用写出，调用的结果随后写入 jsonl，因此不需要另外监听 feature 目录
export class LfgArtifacts {
  private readonly tracker: LfgTracker;
  private planLocked = false;

  constructor(
    private readonly db: Db,
    private readonly runId: string,
    featureDir: string,
  ) {
    this.tracker = new LfgTracker(featureDir, runId);
  }

  record() {
    const { brief, research, plan, tickets } = this.tracker.observe();
    const save = (
      kind: 'brief' | 'research' | 'plan' | 'tickets',
      doc: { path: string } | null,
    ) => {
      if (doc === null) return;
      upsertArtifact(this.db, this.runId, kind, doc.path, fs.readFileSync(doc.path, 'utf8'));
    };
    save('brief', brief);
    if (plan !== null) this.planLocked = true;
    // 锁定之后 Research.md（或 System Design.md）的内容归 plan 产物；research 保留锁定前的快照
    if (!this.planLocked) save('research', research);
    save('plan', plan);
    save('tickets', tickets);
  }
}
