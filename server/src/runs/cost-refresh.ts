import { eq } from 'drizzle-orm';
import { runCostBreakdown } from '../cost.js';
import type { Db } from '../db/index.js';
import { runs } from '../db/schema.js';
import { events } from '../events.js';

// session.updated 触发的刷新，同一 run 最多每这么久一次（Contracts 7.8）
export const COST_REFRESH_MS = 30_000;

// 重新计算 run 的四项成本，写入 runs.cost_usd 缓存；变化时推送 run.cost
export function refreshRunCost(db: Db, runId: string) {
  const row = db.select({ costUsd: runs.costUsd }).from(runs).where(eq(runs.id, runId)).get();
  if (row === undefined) throw new Error(`run ${runId} 不存在`);
  const { total } = runCostBreakdown(db, runId);
  if (total === row.costUsd) return;
  db.update(runs).set({ costUsd: total }).where(eq(runs.id, runId)).run();
  events.publish({ type: 'run.cost', runId, costUsd: total });
}

// 一轮可以持续一两个小时：该 run 的 session 有新请求写入时也刷新成本缓存。
// 距上次刷新不足 COST_REFRESH_MS 时推迟到满 COST_REFRESH_MS 再刷新一次，最后一批写入不会漏掉。
// 刷新出错交给 onError（runner 让 run 失败）。返回停止函数
export function watchRunCost(
  db: Db,
  runId: string,
  sessionId: string,
  onError: (error: Error) => void,
): () => void {
  let last = 0;
  let timer: NodeJS.Timeout | undefined;
  const refresh = () => {
    timer = undefined;
    last = Date.now();
    Promise.resolve()
      .then(() => {
        refreshRunCost(db, runId);
      })
      .catch((error: unknown) => {
        onError(error instanceof Error ? error : new Error(String(error)));
      });
  };
  const unsubscribe = events.subscribe((event) => {
    if (event.type !== 'session.updated' || event.sessionId !== sessionId) return;
    if (timer !== undefined) return;
    const wait = last + COST_REFRESH_MS - Date.now();
    if (wait <= 0) refresh();
    else timer = setTimeout(refresh, wait);
  });
  return () => {
    unsubscribe();
    clearTimeout(timer);
  };
}
