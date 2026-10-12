import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { buildApp } from '../../src/api/app.js';
import { config } from '../../src/config.js';
import type { Db } from '../../src/db/index.js';
import {
  batches,
  liveProcesses,
  liveSessions,
  runs,
  sessions,
  workflowTable,
} from '../../src/db/schema.js';
import { ingestFile } from '../../src/ingest/ingest.js';
import {
  readReport,
  sessionWorkflowId,
  StageReport,
  stageReport as stageReportOf,
  updateStages,
  type WorkflowCycle,
} from '../../src/stages/report.js';
import { loadSessionRows, type RequestRow, type SessionRows } from '../../src/stages/rows.js';
import { syncTasks } from '../../src/tasks/loader.js';
import { loadWorkflow, parseDefinition } from '../../src/workflows/index.js';
import { eq } from 'drizzle-orm';
import { parse } from 'yaml';
import { insertVariant } from '../grading/seed.js';
import { unpackRunFixture } from '../helpers/run-fixture.js';
import { insertSession, openTestDb } from './db.js';
import { SAMPLES } from './samples.js';

const work = path.join(config.repoRoot, '.work', 'test-stage-report', randomUUID());
const { db, close } = openTestDb();
syncTasks(db, config.tasksDir);
insertVariant(db, 'stage-report-v');
// 一次算出的划分用内置的 dev-workflow 定义
const stageReport = (rows: SessionRows, finished: boolean) =>
  stageReportOf(loadWorkflow(db, 'dev-workflow'), rows, finished);
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
      model: 'opus',
      effort: 'high',
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

// dev-workflow 的两个大阶段：StageReport 按定义的顺序列出 lfg、ic（Contracts 16.6）
function cyclesOf(report: StageReport, bigStage: string): WorkflowCycle[] {
  expect(report.workflowId).toBe('dev-workflow');
  expect(report.bigStages.map((b) => b.bigStage)).toEqual(['lfg', 'ic']);
  const found = report.bigStages.find((b) => b.bigStage === bigStage);
  if (found === undefined) throw new Error(`没有大阶段 ${bigStage}`);
  return found.cycles;
}
const lfgCycles = (report: StageReport) => cyclesOf(report, 'lfg');
const icCycles = (report: StageReport) => cyclesOf(report, 'ic');

const views = (c: WorkflowCycle | undefined): Expected[] =>
  (c?.stages ?? []).map((v) => [v.stage, v.status, v.startSeq, v.endSeq, v.entries, v.evidence]);

const skill = (seq: number, text: string) => ({ seq, kind: 'skill', text });
const command = (seq: number, text: string) => ({ seq, kind: 'command', text });

// 守恒：各阶段与 outside 的 mainRequests 之和等于主请求数；各阶段区间互不重叠
function expectConservation(sessionId: string, report: StageReport) {
  const rows = loadSessionRows(db, sessionId);
  const spans = [...lfgCycles(report), ...icCycles(report)].flatMap((c) => c.stages);
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

    expect(lfgCycles(report).map((c) => [c.index, c.label, c.startSeq, c.endSeq])).toEqual([
      [1, '/interview', 138, 548],
    ]);
    expect(views(lfgCycles(report)[0])).toEqual([
      ['interview', 'done', 138, 548, 1, command(138, '/interview')],
      ['research', 'not-reached', null, null, 0, null],
      ['plan', 'not-reached', null, null, 0, null],
      ['ticketing', 'not-reached', null, null, 0, null],
    ]);
    expect(icCycles(report).map((c) => [c.index, c.label, c.startSeq, c.endSeq])).toEqual([
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
    expect(views(icCycles(report)[0])).toEqual([
      ...skippedBefore(549),
      ['open-pr', 'done', 549, 556, 1, skill(549, skillText(549, 'open-pr'))],
      ['fix-pr', 'done', 557, 791, 1, skill(557, skillText(557, 'fix-pr'))],
      ['ready-for-review', 'not-reached', null, null, 0, null],
    ]);
    // PR #77：没有调用 fix-pr，fix-pr 未到达
    expect(views(icCycles(report)[1])).toEqual([
      ...skippedBefore(792),
      ['open-pr', 'done', 792, 1142, 1, skill(792, skillText(792, 'open-pr'))],
      ['fix-pr', 'not-reached', null, null, 0, null],
      ['ready-for-review', 'not-reached', null, null, 0, null],
    ]);
    // PR #78：离线 session 的最后一个阶段为 active
    expect(views(icCycles(report)[2])).toEqual([
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
    const lfg = lfgCycles(report)[0];
    expect(lfgCycles(report).map((c) => [c.index, c.label, c.startSeq, c.endSeq])).toEqual([
      [1, '/lfg 做一个计算器', 0, 172],
    ]);
    expect(icCycles(report)).toEqual([]);
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
    expect(icCycles(report).map((c) => [c.index, c.label, c.startSeq, c.endSeq])).toEqual([
      [1, '/ic TXE-3767', 0, 33],
    ]);
    expect(views(icCycles(report)[0])).toEqual([
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
    expect(icCycles(report)).toHaveLength(1);
    const fix = icCycles(report)[0]?.stages.find((v) => v.stage === 'fix-pr');
    // 34 + 8 条请求：fix-pr 从 #34 到最后一条
    expect(fix).toMatchObject({ status: 'active', startSeq: 34, endSeq: 41, entries: 3 });
    expect(fix?.evidence).toEqual({ seq: 34, kind: 'skill', text: 'Skill: fix-pr' });
    expect(icCycles(report)[0]?.stages.find((v) => v.stage === 'open-pr')).toMatchObject({
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
    expect(icCycles(report).map((c) => [c.label, c.startSeq, c.endSeq])).toEqual([
      ['第 1 轮', 1, 35],
      ['第 2 轮', 36, 39],
    ]);
    expect(
      views(icCycles(report)[1]).map(([stage, status, s, e]) => [stage, status, s, e]),
    ).toEqual([
      ['claim', 'skipped', 36, 35],
      ['readiness', 'skipped', 36, 35],
      ['implement', 'done', 36, 37],
      ['acceptance', 'skipped', 38, 37],
      ['open-pr', 'active', 38, 39],
      ['fix-pr', 'not-reached', null, null],
      ['ready-for-review', 'not-reached', null, null],
    ]);
    expect(icCycles(report)[0]?.stages.find((v) => v.stage === 'fix-pr')).toMatchObject({
      status: 'done',
      startSeq: 34,
      endSeq: 35,
    });
    expectConservation(id, report);
  });
});

// 16.6：绑定到 next-workflow 的 variant 的 session 按 next-workflow 的定义切块
describe('next-workflow 的阶段划分', () => {
  const nextDefinition = parseDefinition(
    parse(
      fs.readFileSync(
        path.join(import.meta.dirname, '../fixtures/workflows/next-workflow.yaml'),
        'utf8',
      ),
    ),
    'next-workflow.yaml',
  );
  db.insert(workflowTable)
    .values({
      id: 'next-workflow',
      name: 'next-workflow',
      definition: nextDefinition,
      updatedAt: new Date(),
    })
    .run();
  insertVariant(db, 'next-v', 'next-workflow');

  test('scope、spike、tickets 一轮 newlfg；build 开启 newic，polish 中的 build 不切换、再次 polish 计次', async () => {
    const base = loadSessionRows(db, '70e7a9b6-fdad-44c3-9b65-015ee2a0499c').main;
    const template = base.find((r) => r.toolCalls.some((c) => c.name === 'Skill'));
    const call = template?.toolCalls.find((c) => c.name === 'Skill');
    const last = base.at(-1);
    if (template === undefined || call === undefined || last === undefined) {
      throw new Error('27yz3d 没有 Skill 调用');
    }
    const names = ['scope', 'spike', 'tickets', 'build', 'ship', 'polish', 'build', 'polish'];
    const extra = names.flatMap((name, i): RequestRow[] => {
      const at = last.timestamp.getTime() + (i + 1) * 60_000;
      return [
        {
          ...template,
          messageId: `${template.messageId}-next-${String(i)}`,
          seq: last.seq + 1 + i * 2,
          timestamp: new Date(at),
          toolCalls: [{ ...call, id: `${call.id}-next-${String(i)}`, input: { skill: name } }],
        },
        {
          ...last,
          messageId: `${last.messageId}-next-${String(i)}-work`,
          seq: last.seq + 2 + i * 2,
          timestamp: new Date(at + 1000),
        },
      ];
    });
    const id = randomUUID();
    insertSession(db, id, [...base, ...extra], null);
    // 先按 dev-workflow 划分（未绑定），绑定后从头按 next-workflow 重算
    updateStages(db, id);
    expect((await stages(id)).workflowId).toBe('dev-workflow');
    db.update(sessions)
      .set({ variantId: 'next-v', variantBinding: 'manual' })
      .where(eq(sessions.id, id))
      .run();
    const report = await stages(id);
    expect(report.workflowId).toBe('next-workflow');
    expect(report.bigStages.map((b) => [b.bigStage, b.title, b.cycles.length])).toEqual([
      ['newlfg', '想法到工单', 1],
      ['newic', '工单到 PR', 1],
    ]);
    const [newlfg, newic] = report.bigStages.map((b) => b.cycles[0]);
    expect([newlfg?.label, newlfg?.startSeq, newlfg?.endSeq]).toEqual(['第 1 轮', 34, 39]);
    // dev-workflow 的 Skill（claim、open-pr 等）不是 next-workflow 的标记
    expect(views(newlfg).map(([stage, status, s, e, n]) => [stage, status, s, e, n])).toEqual([
      ['scope', 'done', 34, 35, 1],
      ['spike', 'done', 36, 37, 1],
      ['tickets', 'done', 38, 39, 1],
    ]);
    expect([newic?.label, newic?.startSeq, newic?.endSeq]).toEqual(['第 1 轮', 40, 49]);
    expect(views(newic).map(([stage, status, s, e, n]) => [stage, status, s, e, n])).toEqual([
      ['build', 'done', 40, 41, 1],
      ['ship', 'done', 42, 43, 1],
      ['polish', 'active', 44, 49, 2],
    ]);
    expect(report.outside.mainRequests).toBe(34);
    expect(report).toEqual(stageReportOf(nextDefinition, loadSessionRows(db, id), false));
  });

  test('交互的 session：取该项最近一次进程所用 variant 的 workflow，本机配置的进程按 dev-workflow', () => {
    const id = randomUUID();
    const liveId = `l-${id.slice(0, 8)}`;
    const now = new Date();
    db.insert(liveSessions)
      .values({
        id: liveId,
        claudeSessionId: id,
        title: 't',
        environment: 'real',
        cwd: '/w',
        updatedAt: now,
      })
      .run();
    insertSession(db, id, loadSessionRows(db, '70e7a9b6-fdad-44c3-9b65-015ee2a0499c').main, null);
    db.update(sessions).set({ liveId }).where(eq(sessions.id, id)).run();
    const processOf = (variantId: string | null) => {
      db.insert(liveProcesses)
        .values({
          liveId,
          kind: 'resume',
          variantId,
          status: 'exited',
          driver: 'human',
          startedAt: now,
        })
        .run();
    };
    processOf(null);
    processOf('next-v');
    expect(sessionWorkflowId(db, id)).toBe('next-workflow');
    processOf(null);
    expect(sessionWorkflowId(db, id)).toBe('dev-workflow');
  });
});
