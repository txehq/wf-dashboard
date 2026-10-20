import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { ImportSource } from '../../scripts/import-run-lib.js';
import { gunzipTree, unpackRunFixture } from './run-fixture.js';

// W4 端到端留下的四个已结束的 run 的来源数据（test/fixtures/w4）：wfd-w4 的 data/（fixture 中为 main-data/，
// data/ 被 gitignore）与 .work/data-ic/ 中 importRun 读取的部分。
// 数据库只留这几个 run 与它们的 variant、batch、对话、产物与评分；variant 的 src/skills 与 variant.json、
// 9f2bed6 的基线导出（两个来源相同，只存一份）逐个文件 gzip；session 取自 test/fixtures/runs/<run id>/，
// 放在 run 的 variant 的配置目录中（variants/<id>/home/claude/projects/<run id>/）
const fixture = path.join(import.meta.dirname, '../fixtures/w4');

export interface W4Source extends ImportSource {
  runId: string;
}

// 解压到 dest 下的 data/ 与 data-ic/；返回四个 run 的来源：已评分的 lfg run、已评分的 ic run、因 GitHub EOF 失败的 ic run、
// 更早一次 ic run（与 a26chw 同一个 task，工单 TXE-3767）
export function unpackW4Data(dest: string): W4Source[] {
  const data = path.join(dest, 'data');
  const dataIc = path.join(dest, 'data-ic');
  const icV3 = path.join(dataIc, 'db-v3.sqlite');
  const sources: W4Source[] = [
    { runId: 'r-20261009-dqva52', dataDir: data },
    { runId: 'r-20261009-a26chw', dataDir: dataIc, dbPath: icV3 },
    { runId: 'r-20261009-780j7l', dataDir: dataIc, dbPath: icV3 },
    { runId: 'r-20261009-27yz3d', dataDir: dataIc },
  ];
  fs.rmSync(dest, { recursive: true, force: true });
  gunzipTree(path.join(fixture, 'main-data'), data);
  gunzipTree(path.join(fixture, 'data-ic'), dataIc);
  for (const dir of [data, dataIc])
    gunzipTree(path.join(fixture, 'bases'), path.join(dir, 'bases'));
  for (const { runId, dataDir, dbPath } of sources) {
    const db = new Database(dbPath ?? path.join(dataDir, 'db.sqlite'), {
      readonly: true,
      fileMustExist: true,
    });
    const run = db
      .prepare('select variant_id as variantId, session_id as sessionId from runs where id = ?')
      .get(runId) as { variantId: string; sessionId: string } | undefined;
    db.close();
    if (run === undefined) throw new Error(`fixture 中没有 run ${runId}`);
    unpackRunFixture(
      runId,
      run.sessionId,
      path.join(dataDir, 'variants', run.variantId, 'home/claude/projects', runId),
    );
  }
  return sources;
}
