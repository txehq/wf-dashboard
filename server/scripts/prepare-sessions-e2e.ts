import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { syncTasks } from '../src/tasks/loader.js';
import { createVariants } from '../src/variants/index.js';
import { BASE_COMMIT } from '../test/helpers/session-fixtures.js';
import { samplesDir } from '../test/stages/samples.js';

// 用法：WFD_DB_PATH=… WFD_DATA_DIR=… WFD_CLAUDE_PROJECTS=.work/e2e/projects WFD_CODEX_HOME=.work/e2e/codex-home
// tsx scripts/prepare-sessions-e2e.ts
// Sessions 页面 e2e 的数据（Contracts 25.1、25.4），每次删除重建：
// - 两个从 txe-workflow 9f2bed6 导入的基线 variant（lfg、ic）。dashboard 发起的 run 的 session 在 variant 自己的配置目录中，
//   这里放进两个真实 run 的 session（test/fixtures/runs 中的原文）：ic run 40f6915a（/ic TXE-3764）在 ic 的基线中，
//   lfg run r-20261009-dqva52（含子代理）在 lfg 的基线中；本机的真实 session f0aca373（一轮 /lfg 与三轮 /ic）也放在
//   ic 的基线中。variant 配置下的 session 由服务的增量导入自动导入，显示阶段
// - 本机配置的一个短 session（"请记住暗号"），在上面三列中勾选后导入，不显示 workflow 与阶段
// - 本机 Codex 的 CODEX_HOME：真实 rollout 的样本在 sessions/ 中，另一份（换了 session id）在 archived_sessions/ 中

if (process.env.WFD_CLAUDE_PROJECTS === undefined) {
  throw new Error('WFD_CLAUDE_PROJECTS 未设置：e2e 的来源目录不能是 ~/.claude/projects');
}
if (process.env.WFD_CODEX_HOME === undefined) {
  throw new Error('WFD_CODEX_HOME 未设置：e2e 的 CODEX_HOME 不能是 ~/.codex');
}
if (
  process.env.WFD_DB_PATH === undefined ||
  config.dataDir === path.join(config.repoRoot, 'data')
) {
  throw new Error('WFD_DB_PATH 与 WFD_DATA_DIR 未设置：e2e 不能写用户实例的 data/');
}
const fixtures = path.join(import.meta.dirname, '../test/fixtures');

// 上一次运行的数据库已删除，其中 variant 与草稿的目录不再有记录
fs.rmSync(config.variantsDir, { recursive: true, force: true });
fs.rmSync(config.workflowDraftsDir, { recursive: true, force: true });
const db = openDatabase(config.dbPath, config.migrationsDir);
syncTasks(db, config.tasksDir);
const variants = createVariants({
  db,
  dataDir: config.dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});
const lfg = await variants.createBaseline({ name: 'e2e 基线', commit: BASE_COMMIT });
const ic = await variants.createBaseline({
  name: 'e2e 基线',
  commit: BASE_COMMIT,
  workflowId: 'ic',
});
const projectsOf = (id: string) => path.join(variants.layout(id).claudeDir, 'projects');
const icProjects = projectsOf(ic.id);
const lfgProjects = projectsOf(lfg.id);
db.$client.close();

const icDir = path.join(icProjects, '-e2e-ic-run');
fs.mkdirSync(icDir, { recursive: true });
fs.copyFileSync(
  path.join(fixtures, 'runs/40f6915a-cd31-4312-866c-dcb377515c42.jsonl'),
  path.join(icDir, '40f6915a-cd31-4312-866c-dcb377515c42.jsonl'),
);

// lfg run 的主 jsonl、子代理与 tool-results 逐个文件 gzip 保存，解压时保持目录结构
const lfgFixture = path.join(fixtures, 'runs/r-20261009-dqva52');
const lfgDir = path.join(lfgProjects, '-e2e-lfg-run');
for (const entry of fs.readdirSync(lfgFixture, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const from = path.join(entry.parentPath, entry.name);
  const to = path.join(lfgDir, path.relative(lfgFixture, from).replace(/\.gz$/, ''));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, zlib.gunzipSync(fs.readFileSync(from)));
}

// 三轮 PR 的离线 session f0aca373（test/fixtures/samples，解压到 .work/samples）
const prsSample = path.join(
  samplesDir,
  '-Users-linhaoz-Project-txe-txe-workflow',
  'f0aca373-863f-4d62-babd-f48055092328',
);
const prsDir = path.join(icProjects, '-e2e-txe-workflow');
fs.mkdirSync(prsDir, { recursive: true });
fs.copyFileSync(`${prsSample}.jsonl`, path.join(prsDir, `${path.basename(prsSample)}.jsonl`));
fs.cpSync(prsSample, path.join(prsDir, path.basename(prsSample)), { recursive: true });

// 本机配置：一个短 session
const local = config.claudeProjectsDir;
fs.rmSync(local, { recursive: true, force: true });
const localDir = path.join(local, '-e2e-local');
fs.mkdirSync(localDir, { recursive: true });
fs.copyFileSync(
  path.join(fixtures, 'live/cfa31f10-e280-4908-bcf7-cbe9b00fbe53.jsonl'),
  path.join(localDir, 'cfa31f10-e280-4908-bcf7-cbe9b00fbe53.jsonl'),
);

// 本机 Codex：真实 rollout 的样本（test/ingest-codex.test.ts）与它的一份已归档的副本
const codexSample = path.join(
  fixtures,
  'codex-rollouts/rollout-2026-10-04T20-22-00-01a106dd-2ba7-7e71-8490-0e170a634111.jsonl',
);
const archivedId = '01a106dd-2ba7-7e71-8490-0e170a634222';
fs.rmSync(config.codexHome, { recursive: true, force: true });
const rollout = path.join(config.codexHome, 'sessions/2026/10/04', path.basename(codexSample));
fs.mkdirSync(path.dirname(rollout), { recursive: true });
fs.copyFileSync(codexSample, rollout);
const archived = path.join(
  config.codexHome,
  'archived_sessions',
  `rollout-2026-10-04T20-22-00-${archivedId}.jsonl`,
);
fs.mkdirSync(path.dirname(archived), { recursive: true });
fs.writeFileSync(
  archived,
  fs
    .readFileSync(codexSample, 'utf8')
    .replaceAll('01a106dd-2ba7-7e71-8490-0e170a634111', archivedId),
);
console.log(
  JSON.stringify({
    variants: { lfg: lfg.id, ic: ic.id },
    sources: [icDir, lfgDir, prsDir, localDir],
    codex: [rollout, archived],
  }),
);
