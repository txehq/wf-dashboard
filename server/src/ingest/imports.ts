import { eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { type SessionEngine, sessionImports, sessions } from '../db/schema.js';

// 导入（Contracts 25.1）：新建 sessions 中的记录时记下导入时间并清空清除时间。用户点"导入 N 个"、
// dashboard 自己的进程（run、Live、设计与优化、Magi Agent）的 watcher 与增量导入都经过这里
export function markImported(db: Db, sessionId: string, engine: SessionEngine, filePath: string) {
  const values = { engine, filePath, importedAt: new Date(), clearedAt: null };
  db.insert(sessionImports)
    .values({ sessionId, ...values })
    .onConflictDoUpdate({ target: sessionImports.sessionId, set: values })
    .run();
}

// 清除（Contracts 25.1）：只记下清除时间，dashboard 中的数据保留，照常增量更新
export function markCleared(db: Db, sessionId: string) {
  db.update(sessionImports)
    .set({ clearedAt: new Date() })
    .where(eq(sessionImports.sessionId, sessionId))
    .run();
}

// 只为分析读入（Contracts 27）：与清除后的状态相同，不在管理表格中、数据保留、照常增量更新；之后从 Sessions 导入它时
// 照常出现（importFiles 清空清除时间）
export const markAnalysisOnly = markCleared;

// 重新进入管理表格：用户再导入，或这个会话启动了新的进程（Live resume、Magi Agent 继续）
export function restoreCleared(db: Db, sessionId: string) {
  db.update(sessionImports)
    .set({ clearedAt: null })
    .where(eq(sessionImports.sessionId, sessionId))
    .run();
}

// 在管理表格中的 session（sessions 的条件）：没有清除过，或清除后又导入了
export const managed = sql`not exists (select 1 from ${sessionImports} where ${sessionImports.sessionId} = ${sessions.id} and ${sessionImports.clearedAt} is not null)`;

// 永久删除（Contracts 24.2、25.3）：文件已不在，导入记录一起删除
export function forgetImports(db: Db, sessionIds: string[]) {
  if (sessionIds.length === 0) return;
  db.delete(sessionImports).where(inArray(sessionImports.sessionId, sessionIds)).run();
}

// 清除过、之后没有再导入的 session
export function clearedSessionIds(db: Db): Set<string> {
  return new Set(
    db
      .select({ id: sessionImports.sessionId })
      .from(sessionImports)
      .where(isNotNull(sessionImports.clearedAt))
      .all()
      .map((r) => r.id),
  );
}
