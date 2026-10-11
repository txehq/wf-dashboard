import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from '../src/config.js';

// 用法：WFD_CLAUDE_PROJECTS=.work/e2e/projects tsx scripts/prepare-sessions-e2e.ts
// Sessions 页面 e2e 的来源目录：每次删除重建，放入两个 dashboard 发起的真实 run 的 session
// （test/fixtures/runs 中的原文）：ic run 40f6915a（/ic TXE-3764）与 lfg run r-20261009-dqva52（含子代理）

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
console.log(JSON.stringify({ target, sources: [icDir, lfgDir] }));
