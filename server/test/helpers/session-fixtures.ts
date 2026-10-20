import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../src/config.js';
import { configSourceDirs } from '../../src/ingest/session-config.js';
import type { SourceDirs } from '../../src/ingest/sources.js';
import { unpackRunFixture } from './run-fixture.js';

// 测试自己的数据目录 <dataDir> 下的来源目录：variant 的配置目录在 <dataDir>/variants 中，其余与服务相同。
// 分析的范围按 session 所在的配置（Contracts 27），被分析的 session 放在 variant 的配置目录 <claudeDir>/projects/ 下
export const sourceDirsOf = (dataDir: string): SourceDirs => ({
  ...configSourceDirs,
  variantsDir: path.join(dataDir, 'variants'),
});

// W31：绑定与分析的测试用两个真实 run 的 session（test/fixtures/runs），以本机来源目录的形式导入，不经过 runs 表
export const BASE_COMMIT = '9f2bed6fbdcef9e30a9a773a95bc5a9d618016ff';
export const LFG = {
  runId: 'r-20261009-dqva52',
  sessionId: '0188c133-3e7b-4592-a963-fc717cf283de',
};
export const IC = { runId: 'r-20261009-27yz3d', sessionId: '70e7a9b6-fdad-44c3-9b65-015ee2a0499c' };
// 另一个 ic run（/ic TXE-3764，同一个 9f2bed6 基线），主 jsonl 一个文件、没有子代理；两个 session 一起分析时与 IC 搭配
export const IC_OTHER = { sessionId: '40f6915a-cd31-4312-866c-dcb377515c42' };

// 复制到 <dir>/projects/-fixture-ic-other/，返回主 jsonl
export function copyOtherIcSession(dir: string): string {
  const target = path.join(dir, 'projects', '-fixture-ic-other');
  fs.mkdirSync(target, { recursive: true });
  const file = path.join(target, `${IC_OTHER.sessionId}.jsonl`);
  fs.copyFileSync(
    path.join(import.meta.dirname, '../fixtures/runs', `${IC_OTHER.sessionId}.jsonl`),
    file,
  );
  return file;
}

// 解包到 <dir>/projects/-fixture-<runId>/，返回主 jsonl
export function unpackSession(dir: string, fixture: { runId: string; sessionId: string }): string {
  return unpackRunFixture(
    fixture.runId,
    fixture.sessionId,
    path.join(dir, 'projects', `-fixture-${fixture.runId}`),
  );
}

// ic session 的副本：换一个 session id，claim 的 skill 正文中 from 换成 to（模拟用改过的 skill 跑出的 session）
export function modifiedIcSession(
  dir: string,
  from: string,
  to: string,
): { sessionId: string; file: string } {
  const source = unpackSession(path.join(dir, 'source'), IC);
  const sessionId = randomUUID();
  const target = path.join(dir, 'projects', '-fixture-modified');
  fs.mkdirSync(target, { recursive: true });
  let replaced = 0;
  const lines = fs
    .readFileSync(source, 'utf8')
    .split('\n')
    .map((line) => {
      if (!line.includes('Base directory for this skill: ') || !line.includes('/skills/claim'))
        return line;
      const record = JSON.parse(line) as { message: { content: { type: string; text: string }[] } };
      for (const block of record.message.content) {
        if (block.type !== 'text' || !block.text.includes(from)) continue;
        block.text = block.text.replace(from, to);
        replaced += 1;
      }
      return JSON.stringify(record);
    });
  if (replaced !== 1) throw new Error(`claim 的正文中 ${from} 出现了 ${String(replaced)} 次`);
  const file = path.join(target, `${sessionId}.jsonl`);
  fs.writeFileSync(file, lines.join('\n'));
  fs.cpSync(path.join(path.dirname(source), IC.sessionId), path.join(target, sessionId), {
    recursive: true,
  });
  return { sessionId, file };
}

export const workDir = (purpose: string) =>
  path.join(config.repoRoot, '.work', `test-${purpose}`, randomUUID());
