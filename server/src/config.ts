import path from 'node:path';
import { fileURLToPath } from 'node:url';

// src/ 与 dist/ 都位于 server/ 下，两级之上即仓库根目录
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const dataDir = path.join(repoRoot, 'data');

export const config = {
  repoRoot,
  host: '127.0.0.1',
  port: 7317,
  dataDir,
  dbPath: path.join(dataDir, 'db.sqlite'),
  variantsDir: path.join(dataDir, 'variants'),
  runsDir: path.join(dataDir, 'runs'),
  tasksDir: path.join(repoRoot, 'tasks'),
  migrationsDir: fileURLToPath(new URL('../drizzle', import.meta.url)),
  // 同时进行的运行数
  runConcurrency: 3,
  // 每个 variant 在每个 task 上的默认重复次数
  defaultRepeats: 3,
  sseHeartbeatMs: 15_000,
} as const;
