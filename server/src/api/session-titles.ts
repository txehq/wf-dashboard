import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { liveSessions, sessions, userMessages } from '../db/schema.js';
import { sessionTitle } from './user-text.js';

// session 的标题，所有显示 session 标题的地方（管理表格、导入的第三列、确认对话框、错误原文、分析）都按这个规则取：
// 属于交互区某一项的取该项的名字（Contracts 14.1、14.3，改名后立即生效），否则取主 session 的首条用户消息
// （sessionTitle：slash 命令显示为 "/lfg 做一个计算器"）。都没有的不在返回中
export function sessionTitles(db: Db, ids: readonly string[]): Map<string, string> {
  if (ids.length === 0) return new Map();
  // SQLite 中与 min() 同行的裸列取自最小值所在的行
  const titles = new Map(
    db
      .select({
        sessionId: userMessages.sessionId,
        text: userMessages.text,
        first: sql<number>`min(${userMessages.timestamp})`,
      })
      .from(userMessages)
      .where(
        and(
          inArray(userMessages.sessionId, [...ids]),
          isNull(userMessages.agentId),
          eq(userMessages.kind, 'user'),
        ),
      )
      .groupBy(userMessages.sessionId)
      .all()
      .map((m) => [m.sessionId, sessionTitle(m.text)]),
  );
  for (const item of db
    .select({ sessionId: sessions.id, title: liveSessions.title })
    .from(sessions)
    .innerJoin(liveSessions, eq(liveSessions.id, sessions.liveId))
    .where(inArray(sessions.id, [...ids]))
    .all())
    titles.set(item.sessionId, item.title);
  return titles;
}
