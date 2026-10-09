import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

// src/ 与 dist/ 都位于 server/ 下，两级之上即仓库根目录
const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
// e2e 用 WFD_DATA_DIR（相对仓库根目录或绝对路径）指向专用的数据目录
const dataDir = path.resolve(repoRoot, process.env.WFD_DATA_DIR ?? 'data');

export const config = {
  repoRoot,
  host: '127.0.0.1',
  // 多个 worktree 并行运行时用 WFD_PORT 错开
  port: z.coerce.number().int().min(1).max(65535).default(7317).parse(process.env.WFD_PORT),
  dataDir,
  dbPath: path.join(dataDir, 'db.sqlite'),
  variantsDir: path.join(dataDir, 'variants'),
  runsDir: path.join(dataDir, 'runs'),
  tasksDir: path.join(repoRoot, 'tasks'),
  // 被评估的 workflow 仓库，基线 variant 从它的 commit 导出
  txeWorkflowRepo: '/Users/linhaoz/Project/txe/txe-workflow',
  // wf-history MCP 直接启动真实的 ctx
  ctxBin: path.join(os.homedir(), '.local/bin/ctx'),
  migrationsDir: fileURLToPath(new URL('../drizzle', import.meta.url)),
  // 同时进行的运行数
  runConcurrency: 3,
  // 每个 variant 在每个 task 上的默认重复次数
  defaultRepeats: 3,
  sseHeartbeatMs: 15_000,
} as const;
