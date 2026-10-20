import fs from 'node:fs';
import path from 'node:path';
import { rebindAll } from '../src/bindings/index.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { tailSessions } from '../src/ingest/session-import.js';
import { defaultSourceDirs } from '../src/ingest/sources.js';
import { syncTasks } from '../src/tasks/loader.js';
import { createVariants } from '../src/variants/index.js';
import { BASE_COMMIT, IC, LFG, unpackSession } from '../test/helpers/session-fixtures.js';

// 用法：WFD_DATA_DIR=.work/e2e/analyses-data WFD_CLAUDE_PROJECTS=.work/e2e/analyses-projects tsx scripts/prepare-analyses-e2e.ts
// 分析页面 e2e 的数据：每次删除重建。从 txe-workflow 9f2bed6 导出基线 variant，两个真实 run 的 session（dqva52 的 lfg、
// 27yz3d 的 ic）放进它的配置目录（run 的 session 本来就在这里；本机配置的 session 不绑定 variant，Contracts 25.4）并导入，
// 自动绑定到它

if (config.dataDir === path.join(config.repoRoot, 'data')) {
  throw new Error('WFD_DATA_DIR 未设置：e2e 数据目录不能是 data/');
}
if (process.env.WFD_CLAUDE_PROJECTS === undefined) {
  throw new Error('WFD_CLAUDE_PROJECTS 未设置：e2e 的来源目录不能是 ~/.claude/projects');
}
fs.rmSync(config.dataDir, { recursive: true, force: true });
fs.rmSync(config.claudeProjectsDir, { recursive: true, force: true });
fs.mkdirSync(config.dataDir, { recursive: true });

const db = openDatabase(config.dbPath, config.migrationsDir);
syncTasks(db, config.tasksDir);
const dirs = defaultSourceDirs;
const variants = createVariants({
  db,
  dataDir: config.dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
  onSkillsChanged: () => {
    rebindAll(db, config.dataDir);
  },
});
const base = await variants.createBaseline({
  name: '基线 9f2bed6',
  commit: BASE_COMMIT,
});
// unpackSession 解包到 <dir>/projects/-fixture-<runId>/：dir 为 variant 的 CLAUDE_CONFIG_DIR
for (const fixture of [LFG, IC]) unpackSession(variants.layout(base.id).claudeDir, fixture);
// variant 的配置目录中的 session 自动导入（Contracts 25.1）
console.log(JSON.stringify({ imported: await tailSessions(db, dirs) }));
console.log(JSON.stringify({ variant: base.id }));
db.$client.close();
