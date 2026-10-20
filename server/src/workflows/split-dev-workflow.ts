import { randomUUID } from 'node:crypto';
import { asc, eq, inArray } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import {
  batchVariants,
  liveProcesses,
  liveSessions,
  runs,
  sessions,
  tasks,
  variants,
  workflowTable,
} from '../db/schema.js';
import { stageItems } from '../stages/partition.js';
import { loadSessionRows } from '../stages/rows.js';
import { builtinDefinition } from './index.js';
import { WorkflowDefinition } from './schema.js';

// W36 的内置 workflow；迁移 0012 删除了它在 workflows 表中的一行，它的 variant 在这里拆开
const DEV_WORKFLOW = 'dev-workflow';

// session 中先出现的 lfg 或 ic 标记（入口命令或小阶段的 Skill 调用）属于哪一个；都没有时为 lfg（Contracts 16.4）
function firstMarkerWorkflow(db: Db, sessionId: string): 'lfg' | 'ic' {
  const partition = [builtinDefinition('lfg'), builtinDefinition('ic')];
  const rows = loadSessionRows(db, sessionId);
  const first = stageItems(partition, rows.main, rows.userMessages).find(
    (item) => item.markers.length > 0,
  )?.markers[0];
  if (first === undefined) return 'lfg';
  const owner = partition.find(
    (w) => w.id === first.name || w.stages.some((s) => s.id === first.name),
  );
  if (owner === undefined) throw new Error(`标记 ${first.name} 不属于 lfg 或 ic`);
  return owner.id === 'ic' ? 'ic' : 'lfg';
}

// 迁移 0012 之后、服务使用数据库之前调用（openDatabase）：每个 dev-workflow 的 variant 拆成两个同名 variant，
// 原来的一个（id 不变）属于 lfg，新建的一个属于 ic 并与它共用目录（storage_id，不重新构建）；run 按 task 的 kind、
// 交互进程与 session 的绑定按 session 中先出现的标记对应。没有 dev-workflow 的 variant 时什么都不做
export function splitDevWorkflow(db: Db) {
  // 其他 workflow 的定义也必须是新的结构：W36 的大阶段结构无法自动对应到一个 workflow
  for (const r of db.select().from(workflowTable).all()) {
    const parsed = WorkflowDefinition.safeParse(r.definition);
    if (!parsed.success) {
      throw new Error(
        `workflow ${r.id} 的定义不是 Contracts 16.1 的结构（W36 的大阶段结构不能自动迁移）：${parsed.error.message}`,
      );
    }
  }
  // 先只读 id：迁移到一半的数据库（迁移的测试）中 variants 还没有后来加的列，没有要拆的 variant 时不读整行
  const pending = db
    .select({ id: variants.id })
    .from(variants)
    .where(eq(variants.workflowId, DEV_WORKFLOW))
    .all();
  if (pending.length === 0) return;
  const dev = db
    .select()
    .from(variants)
    .where(eq(variants.workflowId, DEV_WORKFLOW))
    .orderBy(asc(variants.createdAt), asc(variants.id))
    .all();
  db.transaction((tx) => {
    // 原 variant id → 拆出的 ic variant id
    const icOf = new Map<string, string>();
    for (const v of dev) {
      tx.update(variants).set({ workflowId: 'lfg' }).where(eq(variants.id, v.id)).run();
      const id = randomUUID();
      icOf.set(v.id, id);
      tx.insert(variants)
        .values({ ...v, id, workflowId: 'ic', storageId: v.storageId ?? v.id, parentId: null })
        .run();
    }
    // ic 的 parent 是 parent 拆出的 ic variant
    for (const v of dev) {
      const ic = icOf.get(v.id);
      if (ic === undefined || v.parentId === null) continue;
      tx.update(variants)
        .set({ parentId: icOf.get(v.parentId) ?? v.parentId })
        .where(eq(variants.id, ic))
        .run();
    }
    const icVariant = (id: string) => {
      const ic = icOf.get(id);
      if (ic === undefined) throw new Error(`variant ${id} 没有拆出的 ic variant`);
      return ic;
    };
    const devIds = [...icOf.keys()];
    // run：task 的 kind 为 ic 时对应到 ic 的那个
    const devRuns = tx
      .select({ id: runs.id, variantId: runs.variantId, batchId: runs.batchId, kind: tasks.kind })
      .from(runs)
      .innerJoin(tasks, eq(tasks.id, runs.taskId))
      .where(inArray(runs.variantId, devIds))
      .all();
    for (const r of devRuns) {
      if (r.kind === 'ic') {
        tx.update(runs)
          .set({ variantId: icVariant(r.variantId) })
          .where(eq(runs.id, r.id))
          .run();
      }
    }
    // batch 的 variant 清单按其中 run 实际所用的 variant 重写
    for (const batchId of new Set(devRuns.map((r) => r.batchId))) {
      const used = tx
        .selectDistinct({ variantId: runs.variantId })
        .from(runs)
        .where(eq(runs.batchId, batchId))
        .all();
      tx.delete(batchVariants).where(eq(batchVariants.batchId, batchId)).run();
      for (const u of used) {
        tx.insert(batchVariants).values({ batchId, variantId: u.variantId }).run();
      }
    }
    // session 的绑定：run 的 session 跟随 run，其余按 session 中先出现的标记
    const runVariant = new Map(
      tx
        .select({ sessionId: runs.sessionId, variantId: runs.variantId })
        .from(runs)
        .all()
        .map((r) => [r.sessionId, r.variantId]),
    );
    for (const s of tx
      .select({ id: sessions.id, variantId: sessions.variantId, runId: sessions.runId })
      .from(sessions)
      .where(inArray(sessions.variantId, devIds))
      .all()) {
      const variantId =
        s.runId !== null
          ? (runVariant.get(s.id) ?? s.variantId)
          : firstMarkerWorkflow(db, s.id) === 'ic'
            ? icVariant(s.variantId ?? '')
            : s.variantId;
      tx.update(sessions).set({ variantId }).where(eq(sessions.id, s.id)).run();
    }
    // 交互进程：按这一项的 session 中先出现的标记；session 还没有导入时为 lfg
    for (const p of tx
      .select({
        id: liveProcesses.id,
        variantId: liveProcesses.variantId,
        claudeSessionId: liveSessions.claudeSessionId,
      })
      .from(liveProcesses)
      .innerJoin(liveSessions, eq(liveSessions.id, liveProcesses.liveId))
      .where(inArray(liveProcesses.variantId, devIds))
      .all()) {
      // 有 variant 的进程都是 Claude Code 的项，建出时就有 session id
      if (p.claudeSessionId === null)
        throw new Error(`交互进程 ${String(p.id)} 的项没有 session id`);
      const imported = tx
        .select({ id: sessions.id })
        .from(sessions)
        .where(eq(sessions.id, p.claudeSessionId))
        .get();
      if (imported !== undefined && firstMarkerWorkflow(db, imported.id) === 'ic') {
        tx.update(liveProcesses)
          .set({ variantId: icVariant(p.variantId ?? '') })
          .where(eq(liveProcesses.id, p.id))
          .run();
      }
    }
  });
}
