import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { config } from '../../src/config.js';
import type { Db } from '../../src/db/index.js';
import { batches, runs } from '../../src/db/schema.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import { readReport, StageReport, stageReport, updateStages } from '../../src/stages/report.js';
import { loadSessionRows, type RequestRow } from '../../src/stages/rows.js';
import { syncTasks } from '../../src/tasks/loader.js';
import { insertVariant } from '../grading/seed.js';
import { unpackRunFixture } from '../helpers/run-fixture.js';
import { insertSession, openTestDb } from './db.js';
import { SAMPLES } from './samples.js';

const work = path.join(config.repoRoot, '.work', 'test-stage-report', randomUUID());
const { db, close } = openTestDb();
syncTasks(db, config.tasksDir);
insertVariant(db, 'stage-report-v');
const app = await buildApp({
  db,
  sseHeartbeatMs: config.sseHeartbeatMs,
  logger: false,
  tasksDir: config.tasksDir,
});

beforeAll(async () => {
  await app.ready();
});
afterAll(async () => {
  await app.close();
  close();
  fs.rmSync(work, { recursive: true, force: true });
});

async function stages(id: string) {
  const res = await app.inject({ method: 'GET', url: `/api/sessions/${id}/stages` });
  expect(res.statusCode).toBe(200);
  return StageReport.parse(res.json());
}

// 已到终态的 run：导入 session 时 sessions.run_id 指向它
function finishedRun(runId: string, sessionId: string, taskId: string) {
  db.insert(batches)
    .values({ id: `b-${runId}`, repeats: 1 })
    .run();
  db.insert(runs)
    .values({
      id: runId,
      batchId: `b-${runId}`,
      taskId,
      variantId: 'stage-report-v',
      repeatIndex: 0,
      status: 'succeeded',
      sessionId,
      workspacePath: path.join(work, runId),
    })
    .run();
}

type Expected = [
  stage: string,
  status: string,
  startSeq: number | null,
  endSeq: number | null,
  entries: number,
  evidence: { seq: number; kind: string; text: string } | null,
];

const views = (c: StageReport['ic'][number] | undefined): Expected[] =>
  (c?.stages ?? []).map((v) => [v.stage, v.status, v.startSeq, v.endSeq, v.entries, v.evidence]);

const skill = (seq: number, text: string) => ({ seq, kind: 'skill', text });
const command = (seq: number, text: string) => ({ seq, kind: 'command', text });

// 守恒：各阶段与 outside 的 mainRequests 之和等于主请求数；各阶段区间互不重叠
function expectConservation(sessionId: string, report: StageReport) {
  const rows = loadSessionRows(db, sessionId);
  const spans = [...report.lfg, ...report.ic].flatMap((c) => c.stages);
  const main = spans.reduce((n, v) => n + v.stats.mainRequests, 0);
  expect(main + report.outside.mainRequests).toBe(rows.main.length);
  for (const r of rows.main) {
    const owners = spans.filter(
      (v) => v.startSeq !== null && v.endSeq !== null && r.seq >= v.startSeq && r.seq <= v.endSeq,
    );
    expect(owners.length).toBeLessThanOrEqual(1);
  }
  const all = spans.reduce((n, v) => n + v.stats.requests, 0) + report.outside.requests;
  expect(all).toBe(rows.main.length + rows.subagent.length);
}

describe('真实样本的阶段划分', () => {
  test('f0aca373：/interview 一轮 lfg，Skill open-pr 549、792、1143 各开一轮 ic', async () => {
    const started = performance.now();
    const { sessionId } = ingestFile(db, SAMPLES.icPrs);
    const ingestMs = performance.now() - started;
    const report = await stages(sessionId);
    console.log(
      'f0aca373 导入耗时',
      JSON.stringify({
        ingestMs: Math.round(ingestMs),
        stagesMs: Math.round(performance.now() - started - ingestMs),
      }),
    );

    expect(report.lfg.map((c) => [c.index, c.label, c.startSeq, c.endSeq])).toEqual([
      [1, '/interview', 138, 548],
    ]);
    expect(views(report.lfg[0])).toEqual([
      ['interview', 'done', 138, 548, 1, command(138, '/interview')],
      ['research', 'not-reached', null, null, 0, null],
      ['plan', 'not-reached', null, null, 0, null],
      ['ticketing', 'not-reached', null, null, 0, null],
    ]);
    expect(report.ic.map((c) => [c.index, c.label, c.startSeq, c.endSeq])).toEqual([
      [1, '第 1 轮', 549, 791],
      [2, '第 2 轮', 792, 1142],
      [3, '第 3 轮', 1143, 1230],
    ]);
    const rows = loadSessionRows(db, sessionId);
    const skillText = (seq: number, name: string) => {
      const call = rows.main
        .find((r) => r.seq === seq)
        ?.toolCalls.find(
          (c) => c.name === 'Skill' && (c.input as { skill: string }).skill === name,
        );
      const args = (call?.input as { args: string } | undefined)?.args;
      if (args === undefined) throw new Error(`#${String(seq)} 没有 Skill ${name}`);
      return `Skill: ${name} ${args}`;
    };
    const skippedBefore = (s: number): Expected[] =>
      ['claim', 'readiness', 'implement', 'acceptance'].map((stage) => [
        stage,
        'skipped',
        s,
        s - 1,
        0,
        null,
      ]);
    // PR #72：Skill fix-pr 557
    expect(views(report.ic[0])).toEqual([
      ...skippedBefore(549),
      ['open-pr', 'done', 549, 556, 1, skill(549, skillText(549, 'open-pr'))],
      ['fix-pr', 'done', 557, 791, 1, skill(557, skillText(557, 'fix-pr'))],
      ['ready-for-review', 'not-reached', null, null, 0, null],
    ]);
    // PR #77：没有调用 fix-pr，fix-pr 未到达
    expect(views(report.ic[1])).toEqual([
      ...skippedBefore(792),
      ['open-pr', 'done', 792, 1142, 1, skill(792, skillText(792, 'open-pr'))],
      ['fix-pr', 'not-reached', null, null, 0, null],
      ['ready-for-review', 'not-reached', null, null, 0, null],
    ]);
    // PR #78：离线 session 的最后一个阶段为 active
    expect(views(report.ic[2])).toEqual([
      ...skippedBefore(1143),
      ['open-pr', 'done', 1143, 1153, 1, skill(1143, skillText(1143, 'open-pr'))],
      ['fix-pr', 'active', 1154, 1230, 1, skill(1154, skillText(1154, 'fix-pr'))],
      ['ready-for-review', 'not-reached', null, null, 0, null],
    ]);
    // 第一个标记之前的 138 条请求
    expect(report.outside.mainRequests).toBe(138);
    expectConservation(sessionId, report);
    expect(report).toEqual(stageReport(rows, false));
  }, 300_000);

  test('lfg run dqva52：/lfg 开启的一轮，interview、research、plan、ticketing 依次 done', async () => {
    const runId = 'r-20261009-dqva52';
    const sessionId = '0188c133-3e7b-4592-a963-fc717cf283de';
    finishedRun(runId, sessionId, 'lfg-calculator');
    ingestFile(db, unpackRunFixture(runId, sessionId, path.join(work, runId)));
    const report = await stages(sessionId);
    const lfg = report.lfg[0];
    expect(report.lfg.map((c) => [c.index, c.label, c.startSeq, c.endSeq])).toEqual([
      [1, '/lfg 做一个计算器', 0, 172],
    ]);
    expect(report.ic).toEqual([]);
    expect(
      views(lfg).map(([stage, status, s, e, n, ev]) => [stage, status, s, e, n, ev?.seq]),
    ).toEqual([
      ['interview', 'done', 3, 13, 1, 3],
      ['research', 'done', 14, 86, 1, 14],
      ['plan', 'done', 87, 142, 1, 87],
      ['ticketing', 'done', 143, 172, 1, 143],
    ]);
    expect(lfg?.stages[0]?.evidence?.text.startsWith('Skill: interview 做一个计算器')).toBe(true);
    // /lfg 输入之后到 Skill interview 之前的 #0–#2
    expect(report.outside.mainRequests).toBe(3);
    expectConservation(sessionId, report);
  }, 120_000);

  test('ic run 27yz3d：claim、readiness、implement、open-pr，acceptance skipped', async () => {
    const runId = 'r-20261009-27yz3d';
    const sessionId = '70e7a9b6-fdad-44c3-9b65-015ee2a0499c';
    finishedRun(runId, sessionId, 'ic-money-format');
    ingestFile(db, unpackRunFixture(runId, sessionId, path.join(work, runId)));
    const report = await stages(sessionId);
    expect(report.ic.map((c) => [c.index, c.label, c.startSeq, c.endSeq])).toEqual([
      [1, '/ic TXE-3767', 0, 33],
    ]);
    expect(views(report.ic[0])).toEqual([
      ['claim', 'done', 1, 6, 1, skill(1, 'Skill: claim TXE-3767')],
      [
        'readiness',
        'done',
        7,
        8,
        1,
        skill(7, 'Skill: readiness TXE-3767 --need node>=22.12.0 --need npm'),
      ],
      ['implement', 'done', 9, 22, 1, skill(9, 'Skill: implement TXE-3767')],
      ['acceptance', 'skipped', 23, 22, 0, null],
      // 终态的 run：最后一个阶段为 done；review-pr 不是标记
      ['open-pr', 'done', 23, 33, 1, skill(23, 'Skill: open-pr TXE-3767')],
      ['fix-pr', 'not-reached', null, null, 0, null],
      ['ready-for-review', 'not-reached', null, null, 0, null],
    ]);
    expect(report.outside.mainRequests).toBe(1);
    expectConservation(sessionId, report);
  }, 120_000);
});

// 把 jsonl 按行分成若干段依次写出，每写一段导入一次（同一 message 的多条记录可能分在两段）
function ingestInChunks(target: Db, source: string, dest: string, chunks: number): string {
  const sessionDir = source.replace(/\.jsonl$/, '');
  const file = path.join(dest, path.basename(source));
  fs.mkdirSync(dest, { recursive: true });
  if (fs.existsSync(sessionDir)) {
    fs.cpSync(sessionDir, file.replace(/\.jsonl$/, ''), { recursive: true });
  }
  const lines = fs
    .readFileSync(source, 'utf8')
    .split('\n')
    .filter((l) => l !== '');
  fs.writeFileSync(file, '');
  const size = Math.ceil(lines.length / chunks);
  let sessionId = '';
  for (let i = 0; i < lines.length; i += size) {
    fs.appendFileSync(file, `${lines.slice(i, i + size).join('\n')}\n`);
    sessionId = ingestFile(target, file).sessionId;
  }
  return sessionId;
}

describe('增量导入', () => {
  // 同一 session 不能从两个路径导入：分段导入用另一个测试数据库，与一次导入（第一组测试）比较
  test.each([
    ['f0aca373', SAMPLES.icPrs, 37],
    [
      'dqva52',
      path.join(work, 'r-20261009-dqva52', '0188c133-3e7b-4592-a963-fc717cf283de.jsonl'),
      173,
    ],
  ])(
    '%s 分 %i 段导入与一次导入的结果相同',
    (_name, source, chunks) => {
      const other = openTestDb();
      const sessionId = ingestInChunks(other.db, source, path.join(work, 'chunks', _name), chunks);
      const incremental = readReport(other.db, sessionId);
      const pure = stageReport(loadSessionRows(other.db, sessionId), false);
      other.close();
      const once = readReport(db, sessionId);
      if (once === null || incremental === null) throw new Error('session 没有导入');
      // 分段导入的数据库中没有 run 行：最后一个阶段为 active，其余与一次导入相同
      expect(incremental).toEqual(pure);
      const lastDone = (r: StageReport) =>
        JSON.stringify(r).replaceAll('"status":"active"', '"status":"done"');
      expect(lastDone(incremental)).toBe(lastDone(once));
    },
    300_000,
  );
});

// 由真实请求行拼出的 session：在 27yz3d 的请求之后接上复制的 Skill 调用
describe('fix-pr 与更前面的阶段', () => {
  const runSession = '70e7a9b6-fdad-44c3-9b65-015ee2a0499c';
  const compose = (skills: string[]): string => {
    const base = loadSessionRows(db, runSession).main;
    const template = base.find((r) => r.toolCalls.some((c) => c.name === 'Skill'));
    const last = base.at(-1);
    if (template === undefined || last === undefined) throw new Error('27yz3d 没有 Skill 调用');
    const extra = skills.flatMap((name, i): RequestRow[] => {
      const at = last.timestamp.getTime() + (i + 1) * 60_000;
      const call = template.toolCalls.find((c) => c.name === 'Skill');
      if (call === undefined) throw new Error('模板没有 Skill 调用');
      return [
        {
          ...template,
          messageId: `${template.messageId}-${String(i)}-skill`,
          seq: last.seq + 1 + i * 2,
          timestamp: new Date(at),
          toolCalls: [{ ...call, id: `${call.id}-${String(i)}`, input: { skill: name } }],
        },
        {
          ...last,
          messageId: `${last.messageId}-${String(i)}-work`,
          seq: last.seq + 2 + i * 2,
          timestamp: new Date(at + 1000),
        },
      ];
    });
    const sessionId = randomUUID();
    insertSession(db, sessionId, [...base, ...extra], null);
    updateStages(db, sessionId);
    return sessionId;
  };

  test('fix-pr 多次调用：entries 计数，不切新阶段；fix-pr 中的 acceptance 留在 fix-pr', async () => {
    const id = compose(['fix-pr', 'fix-pr', 'acceptance', 'fix-pr']);
    const report = await stages(id);
    expect(report.ic).toHaveLength(1);
    const fix = report.ic[0]?.stages.find((v) => v.stage === 'fix-pr');
    // 34 + 8 条请求：fix-pr 从 #34 到最后一条
    expect(fix).toMatchObject({ status: 'active', startSeq: 34, endSeq: 41, entries: 3 });
    expect(fix?.evidence).toEqual({ seq: 34, kind: 'skill', text: 'Skill: fix-pr' });
    expect(report.ic[0]?.stages.find((v) => v.stage === 'open-pr')).toMatchObject({
      status: 'done',
      startSeq: 23,
      endSeq: 33,
    });
    expectConservation(id, report);
  });

  test('排在当前阶段之前的阶段开始新一轮，之前的阶段 skipped', async () => {
    const id = compose(['fix-pr', 'implement', 'open-pr']);
    const report = await stages(id);
    // 拼出的 session 没有用户消息：第 1 轮由 Skill claim（#1）开启
    expect(report.ic.map((c) => [c.label, c.startSeq, c.endSeq])).toEqual([
      ['第 1 轮', 1, 35],
      ['第 2 轮', 36, 39],
    ]);
    expect(views(report.ic[1]).map(([stage, status, s, e]) => [stage, status, s, e])).toEqual([
      ['claim', 'skipped', 36, 35],
      ['readiness', 'skipped', 36, 35],
      ['implement', 'done', 36, 37],
      ['acceptance', 'skipped', 38, 37],
      ['open-pr', 'active', 38, 39],
      ['fix-pr', 'not-reached', null, null],
      ['ready-for-review', 'not-reached', null, null],
    ]);
    expect(report.ic[0]?.stages.find((v) => v.stage === 'fix-pr')).toMatchObject({
      status: 'done',
      startSeq: 34,
      endSeq: 35,
    });
    expectConservation(id, report);
  });
});
