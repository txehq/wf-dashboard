import fs from 'node:fs';
import path from 'node:path';
import { type FSWatcher, watch } from 'chokidar';
import { and, eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  sessions,
  stageAnalyses,
  stageSpans,
  type StageStatus,
  type Workflow,
} from '../db/schema.js';
import { events } from '../events.js';
import { advanceIc, BATCH_SIZE, behavioursOf, type IcBoundary } from '../stages/ic.js';
import { type LfgDoc, LfgTracker } from '../stages/lfg.js';
import { icSpans, lfgSpans, type Span } from '../stages/report.js';
import { loadSessionRows, type RequestRow } from '../stages/rows.js';
import { type IcStage, LFG_STAGES, type LfgStage } from '../stages/workflow.js';
import { upsertArtifact } from './records.js';

interface LiveStagesOptions {
  db: Db;
  runId: string;
  sessionId: string;
  workflow: Workflow;
  // 读入 jsonl 的最新内容（ingestFile）；写阶段之前调用，保证 seq 与 session 行都是最新的
  ingest: () => void;
  onError: (error: Error) => void;
}

// 实时运行的阶段判定（Contracts 7.3）：lfg 看 vault feature 目录中的产物，ic 用 Haiku 增量判定；
// 结果写 stage_spans，变化时发 run.stage 与 stage.changed
export abstract class LiveStages {
  protected readonly db: Db;
  protected readonly runId: string;
  protected readonly sessionId: string;
  private readonly statuses = new Map<string, StageStatus>();
  // 判定串行执行
  private queue: Promise<void> = Promise.resolve();

  constructor(protected readonly opts: LiveStagesOptions) {
    this.db = opts.db;
    this.runId = opts.runId;
    this.sessionId = opts.sessionId;
  }

  protected enqueue(work: () => Promise<void> | void): Promise<void> {
    const next = this.queue.then(work);
    // 判定出错时交给 run 记为失败；之后的调用照常排队
    this.queue = next.catch((error: unknown) => {
      this.opts.onError(error instanceof Error ? error : new Error(String(error)));
    });
    return this.queue;
  }

  // 一轮结束时调用
  abstract onTurnEnd(): Promise<void>;
  // 新请求写入（session.updated）时调用
  abstract onSessionUpdated(): void;
  // run 结束：做最后一次判定并停止监听
  abstract close(): Promise<void>;

  protected mainRows(): RequestRow[] {
    this.opts.ingest();
    const session = this.db.select().from(sessions).where(eq(sessions.id, this.sessionId)).get();
    if (session === undefined) return [];
    return loadSessionRows(this.db, this.sessionId).main;
  }

  protected writeSpans(method: 'artifact' | 'llm', spans: Span[]) {
    const { db, sessionId } = this;
    const workflow = this.opts.workflow;
    db.transaction((tx) => {
      if (!tx.select().from(stageAnalyses).where(eq(stageAnalyses.sessionId, sessionId)).get()) {
        tx.insert(stageAnalyses)
          .values({ sessionId, hasLfg: workflow === 'lfg', hasIc: workflow === 'ic' })
          .run();
      }
      tx.delete(stageSpans)
        .where(and(eq(stageSpans.sessionId, sessionId), eq(stageSpans.workflow, workflow)))
        .run();
      for (const s of spans) {
        tx.insert(stageSpans)
          .values({ sessionId, workflow, method, ...s })
          .run();
      }
    });
    for (const s of spans) {
      if (this.statuses.get(s.stage) === s.status) continue;
      this.statuses.set(s.stage, s.status);
      events.publish({
        type: 'run.stage',
        runId: this.runId,
        workflow,
        stage: s.stage,
        status: s.status,
      });
      events.publish({
        type: 'stage.changed',
        sessionId,
        workflow,
        stage: s.stage,
        status: s.status,
      });
    }
  }
}

const lastSeqOf = (rows: RequestRow[]) => rows[rows.length - 1]?.seq ?? -1;

interface LfgDone {
  stage: LfgStage;
  // 产物出现时主 session 的最后一条请求
  seq: number;
  path: string;
  planLockLine: string | null;
}

export class LfgLiveStages extends LiveStages {
  private readonly tracker: LfgTracker;
  private readonly done = new Map<LfgStage, LfgDone>();
  private watcher: FSWatcher | null = null;

  constructor(
    opts: LiveStagesOptions,
    private readonly productDir: string,
    readonly featureDir: string,
  ) {
    super(opts);
    this.tracker = new LfgTracker(featureDir, opts.runId);
  }

  async start() {
    const inFeature = (p: string) =>
      p === this.featureDir || p.startsWith(`${this.featureDir}${path.sep}`);
    // feature 目录在 interview 写出 Brief.md 时才出现，所以监听整个 product 目录
    const watcher = watch(this.productDir, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 },
    });
    watcher.on('all', (_event, p) => {
      if (inFeature(p)) {
        void this.enqueue(() => {
          this.observe();
        });
      }
    });
    watcher.on('error', (error) => {
      this.opts.onError(error instanceof Error ? error : new Error(String(error)));
    });
    await new Promise<void>((resolve) => watcher.once('ready', resolve));
    this.watcher = watcher;
    await this.enqueue(() => {
      this.observe();
    });
  }

  private snapshot(doc: LfgDoc) {
    return fs.readFileSync(doc.path, 'utf8');
  }

  private observe() {
    const progress = this.tracker.observe();
    const rows = this.mainRows();
    const lastSeq = lastSeqOf(rows);
    for (const stage of LFG_STAGES) {
      const doc = progress.stages[stage];
      if (doc === null || this.done.has(stage)) continue;
      this.done.set(stage, { stage, seq: lastSeq, path: doc.path, planLockLine: doc.planLockLine });
    }
    const { interview: brief, research, plan, ticketing } = progress.stages;
    if (brief) upsertArtifact(this.db, this.runId, 'brief', brief.path, this.snapshot(brief));
    // 锁定之后 Research.md（或 System Design.md）的内容归 plan 产物；research 保留锁定前的快照
    if (research && !this.done.has('plan')) {
      upsertArtifact(this.db, this.runId, 'research', research.path, this.snapshot(research));
    }
    if (plan) upsertArtifact(this.db, this.runId, 'plan', plan.path, this.snapshot(plan));
    if (ticketing) {
      upsertArtifact(this.db, this.runId, 'tickets', ticketing.path, this.snapshot(ticketing));
    }
    this.refresh(rows);
  }

  private refresh(rows: RequestRow[]) {
    if (rows.length === 0) return;
    this.writeSpans('artifact', lfgSpans(0, [...this.done.values()], lastSeqOf(rows)));
  }

  onTurnEnd(): Promise<void> {
    // 一轮结束时 active 阶段的区间延伸到最新的请求
    return this.enqueue(() => {
      this.observe();
    });
  }

  onSessionUpdated() {
    // lfg 的阶段只随产物变化
  }

  async close() {
    await this.enqueue(() => {
      this.observe();
    });
    await this.watcher?.close();
  }
}

export class IcLiveStages extends LiveStages {
  private stage: IcStage = 'claim';
  private readonly boundaries: IcBoundary[] = [];
  // 已判定过的行为条数
  private judged = 0;
  private judging = false;

  // 只判定已经完整的请求：最后一条请求在一轮结束前还可能追加 content block
  private behaviours(rows: RequestRow[], complete: boolean) {
    const last = lastSeqOf(rows);
    return behavioursOf(complete ? rows : rows.filter((r) => r.seq < last));
  }

  private async judge(complete: boolean) {
    const rows = this.mainRows();
    if (rows.length === 0) return;
    const fresh = this.behaviours(rows, complete).slice(this.judged);
    if (fresh.length > 0 && this.stage !== 'ready-for-review') {
      const result = await advanceIc(this.db, {
        sessionId: this.sessionId,
        current: this.stage,
        behaviours: fresh,
      });
      this.stage = result.stage;
      this.boundaries.push(...result.boundaries);
    }
    this.judged += fresh.length;
    this.writeSpans('llm', icSpans(0, this.boundaries, lastSeqOf(this.mainRows())));
  }

  onTurnEnd(): Promise<void> {
    return this.enqueue(() => this.judge(true));
  }

  // 新增满 20 条行为时判定一次
  onSessionUpdated() {
    if (this.judging) return;
    const rows = this.mainRows();
    if (this.behaviours(rows, false).length - this.judged < BATCH_SIZE) return;
    this.judging = true;
    void this.enqueue(async () => {
      await this.judge(false);
      this.judging = false;
    });
  }

  async close() {
    await this.enqueue(() => this.judge(true));
  }

  get current(): IcStage {
    return this.stage;
  }
}
