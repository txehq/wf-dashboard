import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { stageChecks } from '../../src/db/schema.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import { models } from '../../src/llm/client.js';
import { IcLiveStages } from '../../src/runs/live-stages.js';
import { BATCH_SIZE, behavioursOf } from '../../src/stages/ic.js';
import {
  analyzeSession,
  readReport,
  type StageView,
  workflowMarks,
} from '../../src/stages/report.js';
import { loadSessionRows } from '../../src/stages/rows.js';
import { unpackRunFixture } from '../helpers/run-fixture.js';
import { openTestDb } from '../stages/db.js';

// W18b 第 5 项：ic run r-20261009-27yz3d 实时判定为 fix-pr 进行中，导入后离线判定为 open-pr 进行中
// （停在首次 /review-pr，按 Stage Markers 2.1 属于 open-pr）。两条路径的批次不同：实时判定每次把
// "上次判定之后的全部行为"作为新的一批，最后一批只有请求 #30–#33（sleep 20; gh pr checks …），
// 模型看不到前面的 Skill open-pr 与首次 /review-pr，判为进入 fix-pr；离线判定按固定大小分批，这几条与
// open-pr 的动作在同一批。实时判定改为与离线相同的批次
const runId = 'r-20261009-27yz3d';
const sessionId = '70e7a9b6-fdad-44c3-9b65-015ee2a0499c';
const work = path.join(config.repoRoot, '.work', 'test-live-stages', randomUUID());
const live = openTestDb();
const offline = openTestDb();

afterAll(() => {
  live.close();
  offline.close();
  fs.rmSync(work, { recursive: true, force: true });
});

// 用户消息（不是 tool_result、不是 isMeta）开始新的一轮
function isUserTurn(line: string): boolean {
  const record = JSON.parse(line) as {
    type: string;
    isMeta?: boolean;
    message?: { content: unknown };
  };
  if (record.type !== 'user' || record.isMeta === true) return false;
  const content = record.message?.content;
  return !(
    Array.isArray(content) && content.some((b) => (b as { type?: string }).type === 'tool_result')
  );
}

const spanOf = (v: StageView) => ({
  stage: v.stage,
  status: v.status,
  startSeq: v.startSeq,
  endSeq: v.endSeq,
});

describe('实时阶段判定与离线判定使用同样的批次（真实 run、真实模型）', () => {
  test('按 runner 的顺序重放 r-20261009-27yz3d：实时的每次提问都落在离线的批次之内', async () => {
    const source = unpackRunFixture(runId, sessionId, path.join(work, 'source'));
    const lines = fs.readFileSync(source, 'utf8').split('\n').filter(Boolean);
    // 实时：主 jsonl 逐段写入（子代理与 tool-results 已在目录中），每段导入后发 session.updated，
    // 下一条用户消息之前一轮结束，最后 run 结束
    const dir = path.join(work, 'live');
    fs.mkdirSync(dir, { recursive: true });
    fs.cpSync(path.join(path.dirname(source), sessionId), path.join(dir, sessionId), {
      recursive: true,
    });
    const file = path.join(dir, `${sessionId}.jsonl`);
    fs.writeFileSync(file, '');
    const errors: Error[] = [];
    const stages = new IcLiveStages(
      {
        db: live.db,
        runId,
        sessionId,
        workflow: 'ic',
        ingest: () => {
          ingestFile(live.db, file);
        },
        onError: (e) => errors.push(e),
      },
      'TXE-3767',
    );
    for (const [i, line] of lines.entries()) {
      if (i > 0 && isUserTurn(line)) await stages.onTurnEnd();
      fs.appendFileSync(file, `${line}\n`);
      if (i % 5 === 4) {
        ingestFile(live.db, file);
        stages.onSessionUpdated();
      }
    }
    await stages.close();
    expect(errors).toEqual([]);

    ingestFile(offline.db, source);
    const judged = await analyzeSession(offline.db, sessionId, models.stageCheck);
    const liveReport = readReport(live.db, sessionId);
    const liveSpans = liveReport?.ic[0]?.stages.map(spanOf);
    const offlineSpans = judged.ic[0]?.stages.map(spanOf);
    console.log('实时', JSON.stringify(liveSpans));
    console.log('离线', JSON.stringify(offlineSpans));

    // 离线的批次：从 ic 起点起的行为按 BATCH_SIZE 条一批，每批的请求范围
    const rows = loadSessionRows(offline.db, sessionId);
    const start = workflowMarks(rows).ic[0];
    if (start === undefined) throw new Error('样本中没有 ic 标志');
    const behaviours = behavioursOf(rows.main.filter((r) => r.seq >= start));
    const chunks: [number, number][] = [];
    for (let i = 0; i < behaviours.length; i += BATCH_SIZE) {
      const batch = behaviours.slice(i, i + BATCH_SIZE);
      chunks.push([batch[0]?.seq ?? -1, batch[batch.length - 1]?.seq ?? -1]);
    }
    // 模型的回答不确定（同一批重复问会得到不同回答），两条路径的结果不能逐项比较；
    // 确定的是提问：实时的每一次提问都落在离线的某一批之内。旧的实现把"上次判定之后的全部行为"
    // 作为一批（例如请求 #7–#18、#18–#29），跨过离线的批次边界，看到的上下文与离线不同
    const checks = (db: typeof live.db) =>
      db
        .select({
          from: stageChecks.fromSeq,
          to: stageChecks.toSeq,
          stage: stageChecks.currentStage,
        })
        .from(stageChecks)
        .where(eq(stageChecks.sessionId, sessionId))
        .all();
    const outsideChunks = (list: ReturnType<typeof checks>) =>
      list.filter((c) => !chunks.some(([from, to]) => from <= c.from && c.to <= to));
    console.log('离线的批次', JSON.stringify(chunks));
    console.log('实时的提问', JSON.stringify(checks(live.db)));
    expect(checks(live.db).length).toBeGreaterThan(0);
    expect(outsideChunks(checks(offline.db))).toEqual([]);
    expect(outsideChunks(checks(live.db))).toEqual([]);
    // 两条路径都得到一轮、阶段齐全
    expect(liveSpans?.map((s) => s.stage)).toEqual(offlineSpans?.map((s) => s.stage));
  }, 600_000);
});

// W15 Medium 10：一次判定失败后，之后的判定以前照常执行，继续写 stage_spans 与 artifacts
describe('实时阶段判定失败之后', () => {
  test('报告一次失败，之后的判定不再执行', async () => {
    const id = randomUUID();
    const dir = path.join(work, 'broken');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.jsonl`);
    // 一条找不到 tool_use 的 tool_result：导入抛错
    fs.writeFileSync(
      file,
      `${JSON.stringify({
        type: 'user',
        uuid: randomUUID(),
        parentUuid: null,
        sessionId: id,
        timestamp: '2026-10-09T15:08:00.000Z',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'toolu_missing', content: 'x' }],
        },
      })}\n`,
    );
    const errors: Error[] = [];
    const stages = new IcLiveStages(
      {
        db: live.db,
        runId: 'r-20261011-broken',
        sessionId: id,
        workflow: 'ic',
        ingest: () => {
          ingestFile(live.db, file);
        },
        onError: (e) => errors.push(e),
      },
      'TXE-1',
    );
    await stages.onTurnEnd();
    await stages.onTurnEnd();
    await stages.close();
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringContaining('tool_result toolu_missing 没有对应的 tool_use'),
    ]);
  });
});
