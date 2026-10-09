import { existsSync } from 'node:fs';
import path from 'node:path';
import { type FSWatcher, watch } from 'chokidar';
import type { Db } from '../db/index.js';
import { ingestFile } from './ingest.js';

// 实时运行：监听主 jsonl 与 <sessionId>/subagents/，每次变化做一次增量导入；监听就绪后返回
export async function watchSession(db: Db, file: string): Promise<FSWatcher> {
  const absolute = path.resolve(file);
  const subagentsDir = path.join(
    path.dirname(absolute),
    path.basename(absolute, '.jsonl'),
    'subagents',
  );
  const watcher = watch([absolute, subagentsDir], { ignoreInitial: true });
  const ingest = () => {
    ingestFile(db, absolute);
  };
  watcher.on('add', ingest);
  watcher.on('change', ingest);
  await new Promise<void>((resolve) => watcher.once('ready', resolve));
  // 运行刚启动时 jsonl 可能还没写出，出现后由 add 事件导入
  if (existsSync(absolute)) ingest();
  return watcher;
}
