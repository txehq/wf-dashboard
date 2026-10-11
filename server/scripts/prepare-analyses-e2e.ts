import fs from 'node:fs';
import path from 'node:path';
import { rebindAll } from '../src/bindings/index.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { importCheckedSources, setCheckedSources } from '../src/ingest/sources.js';
import { syncTasks } from '../src/tasks/loader.js';
import { createVariants } from '../src/variants/index.js';
import { BASE_COMMIT, IC, LFG, unpackSession } from '../test/helpers/session-fixtures.js';

// 用法：WFD_DATA_DIR=.work/e2e/analyses-data WFD_CLAUDE_PROJECTS=.work/e2e/analyses-projects tsx scripts/prepare-analyses-e2e.ts
// 分析页面 e2e 的数据：每次删除重建。来源目录中放两个真实 run 的 session（dqva52 的 lfg、27yz3d 的 ic），
// 勾选并导入；再从 txe-workflow 9f2bed6 导出基线 variant，两个 session 自动绑定到它

if (config.dataDir === path.join(config.repoRoot, 'data')) {
  throw new Error('WFD_DATA_DIR 未设置：e2e 数据目录不能是 data/');
}
if (process.env.WFD_CLAUDE_PROJECTS === undefined) {
  throw new Error('WFD_CLAUDE_PROJECTS 未设置：e2e 的来源目录不能是 ~/.claude/projects');
}
fs.rmSync(config.dataDir, { recursive: true, force: true });
fs.rmSync(config.claudeProjectsDir, { recursive: true, force: true });
fs.mkdirSync(config.dataDir, { recursive: true });
// unpackSession 解包到 <dir>/projects/-fixture-<runId>/
const root = path.dirname(config.claudeProjectsDir);
if (path.basename(config.claudeProjectsDir) !== 'projects') {
  throw new Error(`WFD_CLAUDE_PROJECTS 的最后一级必须是 projects：${config.claudeProjectsDir}`);
}
for (const fixture of [LFG, IC]) unpackSession(root, fixture);

const db = openDatabase(config.dbPath, config.migrationsDir);
syncTasks(db, config.tasksDir);
const dirs = { projectsDir: config.claudeProjectsDir, variantsDir: config.variantsDir };
setCheckedSources(
  db,
  dirs,
  fs.readdirSync(config.claudeProjectsDir).map((d) => path.join(config.claudeProjectsDir, d)),
);
console.log(JSON.stringify(importCheckedSources(db)));
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
  model: 'opus',
  effort: 'high',
});
console.log(JSON.stringify({ variant: base.id }));
db.$client.close();
