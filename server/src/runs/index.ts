import { randomInt, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { runCostBreakdown } from '../cost.js';
import {
  artifacts,
  batches,
  batchTasks,
  batchVariants,
  type RunStatus,
  runs,
  stageSpans,
  tasks,
  variants as variantsTable,
} from '../db/schema.js';
import { events } from '../events.js';
import { featureDir } from '../stages/lfg.js';
import { readReport } from '../stages/report.js';
import { IC_STAGES, LFG_STAGES } from '../stages/workflow.js';
import { HttpError } from '../variants/errors.js';
import { artifactView, listMessages, messageView } from './records.js';
import { RunDriver, type RunnerDeps } from './runner.js';
import type { BatchDetail, BatchSummary, RunDetail, RunSummary } from './views.js';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

// r-<yyyymmdd>-<6 位小写字母数字>：本身是 slug，vault 目录、Linear 与 GitHub 名称都用它
export function newId(prefix: 'r' | 'b', now = new Date()): string {
  const day = now.toISOString().slice(0, 10).replaceAll('-', '');
  const suffix = Array.from({ length: 6 }, () => ID_ALPHABET[randomInt(ID_ALPHABET.length)]).join(
    '',
  );
  return `${prefix}-${day}-${suffix}`;
}

export const RUN_ID = /^r-\d{8}-[a-z0-9]{6}$/;

const terminalStatuses = new Set<RunStatus>(['succeeded', 'failed', 'cancelled']);

type RunRow = typeof runs.$inferSelect;

export interface RunFilter {
  batch?: string | undefined;
  status?: RunStatus | undefined;
  task?: string | undefined;
  variant?: string | undefined;
}

export function createRuns(deps: RunnerDeps) {
  const { db, settings } = deps;
  const drivers = new Map<string, RunDriver>();
  let stopped = false;

  // 上次服务退出时仍在进行的 run 不会再继续
  db.update(runs)
    .set({ status: 'failed', error: '服务重启中断', endedAt: new Date() })
    .where(inArray(runs.status, ['preparing', 'running', 'grading']))
    .run();
  // 取消后正在评分的 run 状态保持 cancelled，评分记为中断
  db.update(runs)
    .set({ gradingStatus: 'failed', gradingError: '服务重启中断' })
    .where(eq(runs.gradingStatus, 'running'))
    .run();

  function pump() {
    const limit = settings.get().runConcurrency;
    while (!stopped && drivers.size < limit) {
      const next = db
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.status, 'queued'))
        .orderBy(asc(runs.createdAt), asc(sql`rowid`))
        .get();
      if (next === undefined) return;
      const driver = new RunDriver(deps, next.id);
      drivers.set(next.id, driver);
      void driver.done.then(() => {
        drivers.delete(next.id);
        pump();
      });
    }
  }

  // 并发设置修改后立即生效：调大时马上启动排队的 run，调小时不中断正在进行的 run
  settings.onChange(() => {
    pump();
  });

  function runRow(id: string): RunRow {
    const row = db.select().from(runs).where(eq(runs.id, id)).get();
    if (row === undefined) throw new HttpError(404, `run 不存在：${id}`);
    return row;
  }

  function driverOf(id: string): RunDriver {
    const row = runRow(id);
    const driver = drivers.get(id);
    if (driver === undefined || row.status !== 'running') {
      throw new HttpError(409, `run ${id} 的状态是 ${row.status}，不在运行中`);
    }
    return driver;
  }

  function currentStages(sessionIds: string[]) {
    const out = new Map<string, RunSummary['currentStage']>();
    if (sessionIds.length === 0) return out;
    const spans = db
      .select()
      .from(stageSpans)
      .where(inArray(stageSpans.sessionId, sessionIds))
      .all();
    for (const id of sessionIds) {
      const own = spans.filter((s) => s.sessionId === id);
      const order = (s: (typeof own)[number]) =>
        (s.workflow === 'lfg' ? LFG_STAGES : IC_STAGES).indexOf(s.stage as never);
      own.sort((a, b) => order(a) - order(b));
      const active = own.find((s) => s.status === 'active');
      const last = [...own].reverse().find((s) => s.status === 'done' || s.status === 'skipped');
      const pick = active ?? last;
      out.set(
        id,
        pick === undefined
          ? null
          : { workflow: pick.workflow, stage: pick.stage, status: pick.status },
      );
    }
    return out;
  }

  function summaries(rows: RunRow[]): RunSummary[] {
    const taskRows = new Map(
      db
        .select()
        .from(tasks)
        .where(inArray(tasks.id, [...new Set(rows.map((r) => r.taskId))]))
        .all()
        .map((t) => [t.id, t]),
    );
    const variantRows = new Map(
      db
        .select()
        .from(variantsTable)
        .where(inArray(variantsTable.id, [...new Set(rows.map((r) => r.variantId))]))
        .all()
        .map((v) => [v.id, v]),
    );
    const stages = currentStages(rows.map((r) => r.sessionId));
    const now = Date.now();
    return rows.map((r) => {
      const task = taskRows.get(r.taskId);
      const variant = variantRows.get(r.variantId);
      if (task === undefined || variant === undefined) {
        throw new Error(`run ${r.id} 的 task 或 variant 不存在`);
      }
      return {
        id: r.id,
        batchId: r.batchId,
        taskId: r.taskId,
        taskKind: task.kind,
        taskTitle: task.title,
        variantId: r.variantId,
        variantName: variant.name,
        repeatIndex: r.repeatIndex,
        status: r.status,
        currentStage: stages.get(r.sessionId) ?? null,
        costUsd: r.costUsd,
        durationMs:
          r.startedAt === null ? null : (r.endedAt?.getTime() ?? now) - r.startedAt.getTime(),
        humanIntervened: r.humanIntervened,
        crossRunRefs: r.crossRunRefs,
        invalidReason: r.invalidReason,
        grading: { status: r.gradingStatus, error: r.gradingError },
        error: r.error,
        createdAt: r.createdAt.getTime(),
        startedAt: r.startedAt?.getTime() ?? null,
        endedAt: r.endedAt?.getTime() ?? null,
      };
    });
  }

  function batchSummary(batch: typeof batches.$inferSelect): BatchSummary {
    const rows = db.select().from(runs).where(eq(runs.batchId, batch.id)).all();
    const statusCounts: Record<string, number> = {};
    for (const r of rows) statusCounts[r.status] = (statusCounts[r.status] ?? 0) + 1;
    return {
      id: batch.id,
      repeats: batch.repeats,
      variantIds: db
        .select()
        .from(batchVariants)
        .where(eq(batchVariants.batchId, batch.id))
        .all()
        .map((v) => v.variantId),
      taskIds: db
        .select()
        .from(batchTasks)
        .where(eq(batchTasks.batchId, batch.id))
        .all()
        .map((t) => t.taskId),
      createdAt: batch.createdAt.getTime(),
      runs: rows.length,
      statusCounts,
      costUsd: rows.reduce((n, r) => n + r.costUsd, 0),
    };
  }

  function batchRow(id: string) {
    const batch = db.select().from(batches).where(eq(batches.id, id)).get();
    if (batch === undefined) throw new HttpError(404, `batch 不存在：${id}`);
    return batch;
  }

  pump();

  return {
    // 冻结全部 variant 后建 batch 与全部 run（queued）
    createBatch(input: { variantIds: string[]; taskIds: string[]; repeats: number }): BatchDetail {
      for (const id of input.variantIds) {
        const v = deps.variants.get(id);
        if (v.buildStatus !== 'built' || v.builtHash !== v.skillsHash) {
          throw new HttpError(400, `variant ${v.name} 还没有按当前内容构建成功`);
        }
      }
      for (const id of input.taskIds) {
        if (db.select().from(tasks).where(eq(tasks.id, id)).get() === undefined) {
          throw new HttpError(400, `task 不存在：${id}`);
        }
      }
      for (const id of input.variantIds) deps.variants.freeze(id);
      const batchId = newId('b');
      db.transaction((tx) => {
        tx.insert(batches).values({ id: batchId, repeats: input.repeats }).run();
        for (const variantId of input.variantIds) {
          tx.insert(batchVariants).values({ batchId, variantId }).run();
        }
        for (const taskId of input.taskIds) tx.insert(batchTasks).values({ batchId, taskId }).run();
        for (const variantId of input.variantIds) {
          for (const taskId of input.taskIds) {
            for (let repeatIndex = 0; repeatIndex < input.repeats; repeatIndex++) {
              const id = newId('r');
              tx.insert(runs)
                .values({
                  id,
                  batchId,
                  taskId,
                  variantId,
                  repeatIndex,
                  sessionId: randomUUID(),
                  workspacePath: path.join(deps.runsDir, id, 'workspace'),
                })
                .run();
            }
          }
        }
      });
      const created = db.select().from(runs).where(eq(runs.batchId, batchId)).all();
      for (const r of created) {
        events.publish({ type: 'run.status', runId: r.id, status: r.status });
      }
      pump();
      return this.getBatch(batchId);
    },

    listBatches(): BatchSummary[] {
      return db.select().from(batches).orderBy(desc(batches.createdAt)).all().map(batchSummary);
    },

    getBatch(id: string): BatchDetail {
      const batch = batchRow(id);
      return {
        ...batchSummary(batch),
        runList: summaries(
          db
            .select()
            .from(runs)
            .where(eq(runs.batchId, id))
            .orderBy(asc(sql`rowid`))
            .all(),
        ),
      };
    },

    listRuns(filter: RunFilter): RunSummary[] {
      const conditions = [
        filter.batch === undefined ? undefined : eq(runs.batchId, filter.batch),
        filter.status === undefined ? undefined : eq(runs.status, filter.status),
        filter.task === undefined ? undefined : eq(runs.taskId, filter.task),
        filter.variant === undefined ? undefined : eq(runs.variantId, filter.variant),
      ];
      return summaries(
        db
          .select()
          .from(runs)
          .where(and(...conditions))
          .orderBy(desc(runs.createdAt), desc(sql`rowid`))
          .all(),
      );
    },

    getRun(id: string): RunDetail {
      const row = runRow(id);
      const [summary] = summaries([row]);
      if (summary === undefined) throw new Error(`run ${id} 没有摘要`);
      const driver = drivers.get(id);
      const artifactRows = db.select().from(artifacts).where(eq(artifacts.runId, id)).all();
      const location = (kind: string) =>
        artifactRows.find((a) => a.kind === kind)?.location ?? null;
      const dir = featureDir(deps.vaultDir, deps.product, id);
      return {
        ...summary,
        sessionId: row.sessionId,
        workspacePath: row.workspacePath,
        mode: driver?.mode ?? 'simulated',
        pending: driver?.pending ?? null,
        stages: readReport(db, row.sessionId),
        messages: listMessages(db, id).map(messageView),
        artifacts: artifactRows.map(artifactView),
        costs: runCostBreakdown(db, id),
        links: {
          repo: location('repo'),
          ticket: location('ticket'),
          pr: row.prUrl,
          vault: summary.taskKind === 'lfg' && fs.existsSync(dir) ? dir : null,
        },
        friction: artifactRows
          .filter((a) => a.kind === 'friction')
          .map((a) => ({ url: a.location, title: a.snapshot ?? '' })),
      };
    },

    takeover(id: string) {
      driverOf(id).takeover();
    },
    release(id: string) {
      driverOf(id).release();
    },
    reply(id: string, text: string) {
      driverOf(id).reply(text);
    },
    answer(id: string, answers: Record<string, string>) {
      driverOf(id).answer(answers);
    },
    finish(id: string) {
      driverOf(id).finish();
    },

    async cancel(id: string) {
      const row = runRow(id);
      if (row.status === 'queued') {
        db.update(runs)
          .set({ status: 'cancelled', endedAt: new Date() })
          .where(and(eq(runs.id, id), eq(runs.status, 'queued')))
          .run();
        events.publish({ type: 'run.status', runId: id, status: 'cancelled' });
        return;
      }
      await driverOf(id).cancel();
    },

    // Contracts 7.12：只对终态的 run 可用；status 与评分保持原样
    setInvalid(id: string, reason: string | null) {
      const row = runRow(id);
      if (!terminalStatuses.has(row.status)) {
        throw new HttpError(409, `run ${id} 还没有结束（${row.status}），不能标记有效性`);
      }
      db.update(runs).set({ invalidReason: reason }).where(eq(runs.id, id)).run();
      events.publish({ type: 'run.status', runId: id, status: row.status });
    },

    // 测试与关闭服务时等待全部进行中的 run 结束
    active(): string[] {
      return [...drivers.keys()];
    },

    // 服务关闭时结束全部 claude 子进程；排队中的 run 保持 queued，下次启动继续
    async shutdown() {
      stopped = true;
      await Promise.all([...drivers.values()].map((d) => d.shutdown()));
    },
  };
}

export type Runs = ReturnType<typeof createRuns>;
