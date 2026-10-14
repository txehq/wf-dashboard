import { existsSync } from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { ingestFile } from './ingest.js';

// 增量导入的间隔。导入只读上次偏移之后的内容，没有新内容时只有一次 open 与 fstat
const POLL_MS = 250;

export interface SessionWatcher {
  close(): Promise<void>;
}

// 正在增量导入的 watcher 数（GET /api/diagnostics）
let activeWatchers = 0;
export const watcherCount = () => activeWatchers;

// 实时运行：每 POLL_MS 对主 jsonl（含 <sessionId>/subagents/）做一次增量导入；首次导入后返回。
// 不依赖文件系统事件：macOS 的 FSEvents 在大量文件写入时会整段丢弃事件，按间隔导入不会漏掉写入。
// 导入错误交给 onError（runner 让这个 run 失败），之后不再导入；不能从定时器中抛出，
// 否则成为 uncaught exception，整个服务退出
export function watchSession(
  db: Db,
  file: string,
  onError: (error: Error) => void,
): SessionWatcher {
  const absolute = path.resolve(file);
  let stopped = false;
  // 运行刚启动时 jsonl 可能还没写出
  const ingestNow = () => {
    if (existsSync(absolute)) ingestFile(db, absolute);
  };
  ingestNow();
  activeWatchers += 1;
  // 关闭与出错都只算一次
  const stop = () => {
    if (stopped) return;
    stopped = true;
    activeWatchers -= 1;
    clearInterval(timer);
  };
  const timer = setInterval(() => {
    // 关闭后（run 结束、测试关闭数据库）或已经出错后不再导入
    if (stopped) return;
    try {
      ingestNow();
    } catch (error) {
      stop();
      onError(error instanceof Error ? error : new Error(String(error)));
    }
  }, POLL_MS);
  return {
    close: () => {
      stop();
      return Promise.resolve();
    },
  };
}
