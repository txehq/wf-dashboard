import fs from 'node:fs';
import path from 'node:path';
import { type FSWatcher, watch } from 'chokidar';
import { eq } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  sessions,
  STAGE_ANALYSIS_VERSION,
  stageAnalyses,
  stageCycles,
  stageSpans,
  type StageStatus,
  type Workflow,
} from '../db/schema.js';
import { events } from '../events.js';
import { models } from '../llm/client.js';
import {
  advanceIc,
  BATCH_SIZE,
  type Behaviour,
  behavioursOf,
  type IcBoundary,
  type IcState,
} from '../stages/ic.js';
import { type LfgDoc, LfgTracker } from '../stages/lfg.js';
import { type Cycle, icCycles, lfgCycle, workflowMarks } from '../stages/report.js';
import { loadSessionRows, type RequestRow, type SessionRows } from '../stages/rows.js';
import { LFG_STAGES, type LfgStage } from '../stages/workflow.js';
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

// 实时运行的阶段判定（Contracts 7.3）：lfg 看 vault feature 目录中的产物，ic 用 models.stageCheck 增量判定。
// 一个 run 的 session 只有一轮流程：写 stage_cycles 第 1 轮与它的 stage_spans，变化时发 run.stage 与 stage.changed
export abstract class LiveStages {
  protected readonly db: Db;
  protected readonly runId: string;
  protected readonly sessionId: string;
  private readonly statuses = new Map<string, StageStatus>();
  // 判定串行执行
  private queue: Promise<void> = Promise.resolve();
  // 一次判定出错后 run 失败，之后的判定不再执行，也不再写 stage_spans 与 artifacts
  private failed = false;

  constructor(protected readonly opts: LiveStagesOptions) {
    this.db = opts.db;
    this.runId = opts.runId;
    this.sessionId = opts.sessionId;
  }

  protected enqueue(work: () => Promise<void> | void): Promise<void> {
    const next = this.queue.then(() => (this.failed ? undefined : work()));
    // 判定出错时交给 run 记为失败
    this.queue = next.catch((error: unknown) => {
      this.failed = true;
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
  // run 失败：不再判定，停止监听
  async stop(): Promise<void> {
    this.failed = true;
    await this.queue;
  }

  // jsonl 还没写出 session 时为 null
  protected sessionRows(): SessionRows | null {
    this.opts.ingest();
    const session = this.db.select().from(sessions).where(eq(sessions.id, this.sessionId)).get();
    if (session === undefined) return null;
    return loadSessionRows(this.db, this.sessionId);
  }

  protected writeCycle(method: 'artifact' | 'llm', cycle: Cycle) {
    const { db, sessionId } = this;
    const workflow = this.opts.workflow;
    db.transaction((tx) => {
      if (!tx.select().from(stageAnalyses).where(eq(stageAnalyses.sessionId, sessionId)).get()) {
        tx.insert(stageAnalyses)
          .values({
            sessionId,
            version: STAGE_ANALYSIS_VERSION,
            hasLfg: workflow === 'lfg',
            hasIc: workflow === 'ic',
          })
          .run();
      }
      tx.delete(stageSpans).where(eq(stageSpans.sessionId, sessionId)).run();
      tx.delete(stageCycles).where(eq(stageCycles.sessionId, sessionId)).run();
      tx.insert(stageCycles)
        .values({
          sessionId,
          workflow,
          cycle: 1,
          label: cycle.label,
          startSeq: cycle.startSeq,
          endSeq: cycle.endSeq,
        })
        .run();
      for (const s of cycle.spans) {
        tx.insert(stageSpans)
          .values({ sessionId, workflow, cycle: 1, method, ...s })
          .run();
      }
    });
    for (const s of cycle.spans) {
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
    const rows = this.sessionRows();
    const lastSeq = rows === null ? -1 : lastSeqOf(rows.main);
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
    if (rows === null || rows.main.length === 0) return;
    // 一轮从第一条请求（/lfg 初始消息）开始，dispatch gate 的回答之后结束
    const { spans, endSeq } = lfgCycle(rows, 0, [...this.done.values()], lastSeq);
    this.writeCycle('artifact', { label: this.runId, startSeq: 0, endSeq, spans });
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

  override async stop() {
    await super.stop();
    await this.watcher?.close();
  }
}

interface IcJudged {
  state: IcState;
  boundaries: IcBoundary[];
}

// advanceIc 每次调用从 0 起给轮次编号（0 为调用开始时已在进行的一轮）；接在已有的 cycles 轮之后时换成整个 session 的编号
function renumber(boundaries: IcBoundary[], cycles: number): IcBoundary[] {
  return boundaries.map((b) => ({ ...b, cycle: b.cycle === 0 ? cycles : cycles + b.cycle }));
}

const cyclesOf = (boundaries: IcBoundary[]) => Math.max(0, ...boundaries.map((b) => b.cycle));

// 与离线判定（stages/report 的 judgeIcSession）使用同一组批次：行为从 ic 的第一个粗判标志所在的请求起，
// 以流程外为初始状态，按 20 条一批。只有满 20 条的批次计入已确定的结果；不满一批的末尾在一轮结束时
// 从已确定的状态起临时判定，用于显示，下一次判定时连同新增的行为重新判；run 结束时最后一批计入。
// 这样 run 结束时的结果与导入后离线判定的结果来自同样的批次与同样的提问
export class IcLiveStages extends LiveStages {
  private committed: IcJudged = { state: 'outside', boundaries: [] };
  // 已确定的行为条数
  private judged = 0;
  private judging = false;
  // ic 第一个粗判标志所在的请求：一经出现就不会再变，批次从这里起
  private icStart: number | undefined;

  constructor(
    opts: LiveStagesOptions,
    // 轮次标签：工单 identifier
    private readonly label: string,
  ) {
    super(opts);
  }

  // complete 为 false 时不含最后一条请求：它在一轮结束前还可能追加 content block
  private behaviours(rows: SessionRows, complete: boolean): Behaviour[] {
    const start = workflowMarks(rows).ic[0];
    if (start === undefined) return [];
    if (this.icStart !== undefined && start !== this.icStart) {
      throw new Error(`ic 的起点从请求 #${String(this.icStart)} 变成了 #${String(start)}`);
    }
    this.icStart = start;
    const last = lastSeqOf(rows.main);
    return behavioursOf(rows.main.filter((r) => r.seq >= start && (complete || r.seq < last)));
  }

  // 第一轮已经离开：run 在 ready-for-review 之后结束，之后的行为不再判定
  private left(judged: IcJudged): boolean {
    return judged.boundaries.some((b) => b.cycle === 1 && b.stage === 'outside');
  }

  private async advance(from: IcJudged, behaviours: Behaviour[]): Promise<IcJudged> {
    const result = await advanceIc(this.db, {
      sessionId: this.sessionId,
      current: from.state,
      behaviours,
      model: models.stageCheck,
    });
    return {
      state: result.stage,
      boundaries: [...from.boundaries, ...renumber(result.boundaries, cyclesOf(from.boundaries))],
    };
  }

  private async judge(complete: boolean, final: boolean) {
    const rows = this.sessionRows();
    if (rows === null || rows.main.length === 0) return;
    const all = this.behaviours(rows, complete);
    const whole = Math.floor((all.length - this.judged) / BATCH_SIZE) * BATCH_SIZE;
    if (whole > 0 && !this.left(this.committed)) {
      this.committed = await this.advance(
        this.committed,
        all.slice(this.judged, this.judged + whole),
      );
    }
    this.judged += whole;
    let shown = this.committed;
    const rest = all.slice(this.judged);
    if (complete && rest.length > 0 && !this.left(this.committed)) {
      shown = await this.advance(this.committed, rest);
      if (final) {
        this.committed = shown;
        this.judged += rest.length;
      }
    }
    const cycle = icCycles(shown.boundaries, this.sessionRows()?.main ?? [])[0];
    if (cycle === undefined) return;
    this.writeCycle('llm', { ...cycle, label: this.label });
  }

  onTurnEnd(): Promise<void> {
    return this.enqueue(() => this.judge(true, false));
  }

  // 新增满一批行为时判定一次
  onSessionUpdated() {
    if (this.judging) return;
    const rows = this.sessionRows();
    if (rows === null || this.behaviours(rows, false).length - this.judged < BATCH_SIZE) {
      return;
    }
    this.judging = true;
    void this.enqueue(async () => {
      await this.judge(false, false);
      this.judging = false;
    });
  }

  async close() {
    await this.enqueue(() => this.judge(true, true));
  }
}
