import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { type FSWatcher, watch } from 'chokidar';
import type { Db } from '../db/index.js';
import { ingestFile } from './ingest.js';

// chokidar 对同一文件 50 ms 内的后续 change 事件直接丢弃，不补发最后一次；
// 每次事件后再等这么久补做一次导入，读入连续写入的最后一段
const TRAILING_MS = 200;

// 实时运行：监听主 jsonl 与 <sessionId>/subagents/，每次变化做一次增量导入；监听就绪后返回。
// chokidar 监听尚不存在的目录中的文件时，另一个进程建目录并写入不会产生事件，
// 所以先建好 jsonl 所在目录，监听这个目录，只处理主 jsonl 与 subagents/ 下的变化
export async function watchSession(db: Db, file: string): Promise<FSWatcher> {
  const absolute = path.resolve(file);
  const dir = path.dirname(absolute);
  const subagentsDir = path.join(dir, path.basename(absolute, '.jsonl'), 'subagents');
  mkdirSync(dir, { recursive: true });
  const watcher = watch(dir, { ignoreInitial: true });
  let trailing: NodeJS.Timeout | undefined;
  const ingest = (changed: string) => {
    if (changed !== absolute && !changed.startsWith(`${subagentsDir}${path.sep}`)) return;
    ingestFile(db, absolute);
    clearTimeout(trailing);
    trailing = setTimeout(() => {
      // 监听关闭后（run 结束、测试关闭数据库）不再导入
      if (!watcher.closed) ingestFile(db, absolute);
    }, TRAILING_MS);
  };
  watcher.on('add', ingest);
  watcher.on('change', ingest);
  await new Promise<void>((resolve) => watcher.once('ready', resolve));
  // 运行刚启动时 jsonl 可能还没写出，出现后由 add 事件导入
  if (existsSync(absolute)) ingestFile(db, absolute);
  return watcher;
}
