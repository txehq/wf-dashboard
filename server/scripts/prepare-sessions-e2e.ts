import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from '../src/config.js';

// 用法：WFD_CLAUDE_PROJECTS=.work/e2e/projects tsx scripts/prepare-sessions-e2e.ts
// Sessions 页面 e2e 的来源目录：每次删除重建，放入两个 dashboard 发起的真实 run 的 session
// （test/fixtures/runs 中的原文）：ic run 40f6915a（/ic TXE-3764）与 lfg run r-20261009-dqva52（含子代理），
// 以及本机的真实 session f0aca373（一轮 /lfg 与三轮 /ic）

const target = config.claudeProjectsDir;
if (process.env.WFD_CLAUDE_PROJECTS === undefined) {
  throw new Error('WFD_CLAUDE_PROJECTS 未设置：e2e 的来源目录不能是 ~/.claude/projects');
}
const fixtures = path.join(import.meta.dirname, '../test/fixtures/runs');

fs.rmSync(target, { recursive: true, force: true });
const icDir = path.join(target, '-e2e-ic-run');
fs.mkdirSync(icDir, { recursive: true });
fs.copyFileSync(
  path.join(fixtures, '40f6915a-cd31-4312-866c-dcb377515c42.jsonl'),
  path.join(icDir, '40f6915a-cd31-4312-866c-dcb377515c42.jsonl'),
);

// lfg run 的主 jsonl、子代理与 tool-results 逐个文件 gzip 保存，解压时保持目录结构
const lfgFixture = path.join(fixtures, 'r-20261009-dqva52');
const lfgDir = path.join(target, '-e2e-lfg-run');
for (const entry of fs.readdirSync(lfgFixture, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile()) continue;
  const from = path.join(entry.parentPath, entry.name);
  const to = path.join(lfgDir, path.relative(lfgFixture, from).replace(/\.gz$/, ''));
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, zlib.gunzipSync(fs.readFileSync(from)));
}

// 三轮 PR 的离线 session f0aca373（主仓库 .spikes/stage-markers/samples，worktree 经 git common dir 找到主仓库）
const mainRepo = path.dirname(
  path.resolve(execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim()),
);
const prsSample = path.join(
  mainRepo,
  '.spikes/stage-markers/samples/-Users-linhaoz-Project-txe-txe-workflow',
  'f0aca373-863f-4d62-babd-f48055092328',
);
const prsDir = path.join(target, '-e2e-txe-workflow');
fs.mkdirSync(prsDir, { recursive: true });
fs.copyFileSync(`${prsSample}.jsonl`, path.join(prsDir, `${path.basename(prsSample)}.jsonl`));
fs.cpSync(prsSample, path.join(prsDir, path.basename(prsSample)), { recursive: true });
console.log(JSON.stringify({ target, sources: [icDir, lfgDir, prsDir] }));
