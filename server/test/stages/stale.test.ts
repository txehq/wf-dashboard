import fs from 'node:fs';
import path from 'node:path';
import { afterAll, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import { analyzeSession, readReport, type StageReport } from '../../src/stages/report.js';
import { loadSessionRows } from '../../src/stages/rows.js';
import { openTestDb } from './db.js';
import { SAMPLES, TEST_STAGE_MODEL } from './samples.js';

const { db, close } = openTestDb();
afterAll(close);

// 各轮全部阶段与流程外：mainRequests 之和等于主 agent 请求总数，requests 之和等于全部请求（含子代理）
function totals(report: StageReport) {
  const stages = [...report.lfg, ...report.ic].flatMap((c) => c.stages);
  return {
    main: stages.reduce((n, s) => n + s.stats.mainRequests, 0) + report.outside.mainRequests,
    all: stages.reduce((n, s) => n + s.stats.requests, 0) + report.outside.requests,
  };
}

function sessionTotals(sessionId: string) {
  const rows = loadSessionRows(db, sessionId);
  return { main: rows.main.length, all: rows.main.length + rows.subagent.length };
}

// W15 H3（复现文件 wfd-w15/.work/review-ingest/stale.ts）：先导入 d93c4511 的前一半并判定，
// 再追加其余部分重新导入；已判定的结果随 session 增长，lfg 停在 interview 的这一轮延伸到最后一条请求
test('判定之后 session 继续增长：进行中的阶段延伸到最后一条请求，请求数守恒', async () => {
  const id = path.basename(SAMPLES.interview, '.jsonl');
  const work = path.join(config.repoRoot, '.work', 'stages-stale', 'proj');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  fs.cpSync(path.join(path.dirname(SAMPLES.interview), id), path.join(work, id), {
    recursive: true,
  });
  const lines = fs.readFileSync(SAMPLES.interview, 'utf8').split('\n');
  const half = Math.floor(lines.length / 2);
  const file = path.join(work, `${id}.jsonl`);
  fs.writeFileSync(file, lines.slice(0, half).join('\n') + '\n');
  ingestFile(db, file);

  const first = await analyzeSession(db, id, TEST_STAGE_MODEL);
  expect(totals(first)).toEqual(sessionTotals(id));
  const before = sessionTotals(id);

  fs.appendFileSync(file, lines.slice(half).join('\n'));
  ingestFile(db, file);
  const after = sessionTotals(id);
  expect(after.main).toBeGreaterThan(before.main);

  const later = readReport(db, id);
  if (later === null) throw new Error('没有判定结果');
  console.log('判定时', JSON.stringify({ ...totals(first), session: before }));
  console.log('追加后', JSON.stringify({ ...totals(later), session: after }));
  expect(totals(later)).toEqual(after);
  const lastSeq = loadSessionRows(db, id).main.at(-1)?.seq;
  expect(later.lfg[0]?.endSeq).toBeNull();
  expect(later.lfg[0]?.stages[0]).toMatchObject({
    stage: 'interview',
    status: 'active',
    endSeq: lastSeq,
  });
  // 判定没有重新进行
  expect(later.checks).toEqual(first.checks);
});
