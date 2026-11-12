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
  sessionPartition,
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
// A one-pass partition uses both built-in lfg and ic (Contracts 16.6)
const builtins = () => [loadWorkflow(db, 'lfg'), loadWorkflow(db, 'ic')];
const stageReport = (rows: SessionRows, finished: boolean) =>
  stageReportOf(builtins(), rows, finished);
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

// A run in a final state: sessions.run_id points to it when the session is imported
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

// Built-in lfg and ic: StageReport lists them in the order lfg, ic (Contracts 16.6)
function cyclesOf(report: StageReport, workflow: string): WorkflowCycle[] {
  expect(report.workflows.map((w) => w.workflow)).toEqual(['lfg', 'ic']);
  const found = report.workflows.find((w) => w.workflow === workflow);
  if (found === undefined) throw new Error(`No workflow ${workflow}`);
  return found.cycles;
}
const lfgCycles = (report: StageReport) => cyclesOf(report, 'lfg');
const icCycles = (report: StageReport) => cyclesOf(report, 'ic');

const views = (c: WorkflowCycle | undefined): Expected[] =>
  (c?.stages ?? []).map((v) => [v.stage, v.status, v.startSeq, v.endSeq, v.entries, v.evidence]);

const skill = (seq: number, text: string) => ({ seq, kind: 'skill', text });
const command = (seq: number, text: string) => ({ seq, kind: 'command', text });

// Conservation: the mainRequests of all stages plus outside equal the main request count; stage ranges do not overlap
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

describe('stage partition of real samples', () => {
  test('f0aca373: /interview opens one lfg cycle; Skill open-pr at 549, 792 and 1143 each opens an ic cycle', async () => {
    const started = performance.now();
    const { sessionId } = ingestFile(db, SAMPLES.icPrs);
    const ingestMs = performance.now() - started;
    const report = await stages(sessionId);
    console.log(
      'f0aca373 import duration',
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
      [1, 'Round 1', 549, 791],
      [2, 'Round 2', 792, 1142],
      [3, 'Round 3', 1143, 1230],
    ]);
    const rows = loadSessionRows(db, sessionId);
    const skillText = (seq: number, name: string) => {
      const call = rows.main
        .find((r) => r.seq === seq)
        ?.toolCalls.find(
          (c) => c.name === 'Skill' && (c.input as { skill: string }).skill === name,
        );
      const args = (call?.input as { args: string } | undefined)?.args;
      if (args === undefined) throw new Error(`#${String(seq)} has no Skill ${name}`);
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
    // PR #72: Skill fix-pr at 557
    expect(views(icCycles(report)[0])).toEqual([
      ...skippedBefore(549),
      ['open-pr', 'done', 549, 556, 1, skill(549, skillText(549, 'open-pr'))],
      ['fix-pr', 'done', 557, 791, 1, skill(557, skillText(557, 'fix-pr'))],
      ['ready-for-review', 'not-reached', null, null, 0, null],
    ]);
    // PR #77: fix-pr was not called, so it is not reached
    expect(views(icCycles(report)[1])).toEqual([
      ...skippedBefore(792),
      ['open-pr', 'done', 792, 1142, 1, skill(792, skillText(792, 'open-pr'))],
      ['fix-pr', 'not-reached', null, null, 0, null],
      ['ready-for-review', 'not-reached', null, null, 0, null],
    ]);
    // PR #78: the last stage of an offline session is active
    expect(views(icCycles(report)[2])).toEqual([
      ...skippedBefore(1143),
      ['open-pr', 'done', 1143, 1153, 1, skill(1143, skillText(1143, 'open-pr'))],
      ['fix-pr', 'active', 1154, 1230, 1, skill(1154, skillText(1154, 'fix-pr'))],
      ['ready-for-review', 'not-reached', null, null, 0, null],
    ]);
    // The 138 requests before the first marker
    expect(report.outside.mainRequests).toBe(138);
    expectConservation(sessionId, report);
    expect(report).toEqual(stageReport(rows, false));
  }, 300_000);

  test('lfg run dqva52: one cycle opened by /lfg, interview, research, plan and ticketing done in order', async () => {
    const runId = 'r-20261009-dqva52';
    const sessionId = '0188c133-3e7b-4592-a963-fc717cf283de';
    finishedRun(runId, sessionId, 'lfg-calculator');
    ingestFile(db, unpackRunFixture(runId, sessionId, path.join(work, runId)));
    const report = await stages(sessionId);
    const lfg = lfgCycles(report)[0];
    expect(lfgCycles(report).map((c) => [c.index, c.label, c.startSeq, c.endSeq])).toEqual([
      [1, '/lfg build a calculator', 0, 172],
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
    expect(lfg?.stages[0]?.evidence?.text.startsWith('Skill: interview build a calculator')).toBe(
      true,
    );
    // #0-#2 between the /lfg input and Skill interview
    expect(report.outside.mainRequests).toBe(3);
    expectConservation(sessionId, report);
  }, 120_000);

  test('ic run 27yz3d: claim, readiness, implement, open-pr; acceptance skipped', async () => {
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
      // A run in a final state: the last stage is done; review-pr is not a marker
      ['open-pr', 'done', 23, 33, 1, skill(23, 'Skill: open-pr TXE-3767')],
      ['fix-pr', 'not-reached', null, null, 0, null],
      ['ready-for-review', 'not-reached', null, null, 0, null],
    ]);
    expect(report.outside.mainRequests).toBe(1);
    expectConservation(sessionId, report);
  }, 120_000);
});

// Writes the jsonl in several line chunks, importing after each (records of one message may fall into two chunks)
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

describe('incremental import', () => {
  // One session cannot be imported from two paths: the chunked import uses another test database and is compared
  // with the one-pass import (first group of tests)
  test.each([
    ['f0aca373', SAMPLES.icPrs, 37],
    [
      'dqva52',
      path.join(work, 'r-20261009-dqva52', '0188c133-3e7b-4592-a963-fc717cf283de.jsonl'),
      173,
    ],
  ])(
    '%s imported in %i chunks gives the same result as one import',
    (_name, source, chunks) => {
      const other = openTestDb();
      const sessionId = ingestInChunks(other.db, source, path.join(work, 'chunks', _name), chunks);
      const incremental = readReport(other.db, sessionId);
      const pure = stageReport(loadSessionRows(other.db, sessionId), false);
      other.close();
      const once = readReport(db, sessionId);
      if (once === null || incremental === null) throw new Error('Session not imported');
      // The chunked database has no run row: the last stage is active, everything else matches the one-pass import
      expect(incremental).toEqual(pure);
      const lastDone = (r: StageReport) =>
        JSON.stringify(r).replaceAll('"status":"active"', '"status":"done"');
      expect(lastDone(incremental)).toBe(lastDone(once));
    },
    300_000,
  );
});

// A session composed from real request rows: copied Skill calls appended after the 27yz3d requests
describe('fix-pr and earlier stages', () => {
  const runSession = '70e7a9b6-fdad-44c3-9b65-015ee2a0499c';
  const compose = (skills: string[]): string => {
    const base = loadSessionRows(db, runSession).main;
    const template = base.find((r) => r.toolCalls.some((c) => c.name === 'Skill'));
    const last = base.at(-1);
    if (template === undefined || last === undefined) throw new Error('27yz3d has no Skill call');
    const extra = skills.flatMap((name, i): RequestRow[] => {
      const at = last.timestamp.getTime() + (i + 1) * 60_000;
      const call = template.toolCalls.find((c) => c.name === 'Skill');
      if (call === undefined) throw new Error('The template has no Skill call');
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

  test('repeated fix-pr calls count entries without a new stage; acceptance inside fix-pr stays in fix-pr', async () => {
    const id = compose(['fix-pr', 'fix-pr', 'acceptance', 'fix-pr']);
    const report = await stages(id);
    expect(icCycles(report)).toHaveLength(1);
    const fix = icCycles(report)[0]?.stages.find((v) => v.stage === 'fix-pr');
    // 34 + 8 requests: fix-pr runs from #34 to the last one
    expect(fix).toMatchObject({ status: 'active', startSeq: 34, endSeq: 41, entries: 3 });
    expect(fix?.evidence).toEqual({ seq: 34, kind: 'skill', text: 'Skill: fix-pr' });
    expect(icCycles(report)[0]?.stages.find((v) => v.stage === 'open-pr')).toMatchObject({
      status: 'done',
      startSeq: 23,
      endSeq: 33,
    });
    expectConservation(id, report);
  });

  test('a stage before the current one starts a new cycle, with earlier stages skipped', async () => {
    const id = compose(['fix-pr', 'implement', 'open-pr']);
    const report = await stages(id);
    // The composed session has no user messages: Skill claim (#1) opens cycle 1
    expect(icCycles(report).map((c) => [c.label, c.startSeq, c.endSeq])).toEqual([
      ['Round 1', 1, 35],
      ['Round 2', 36, 39],
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

// 16.6: a session whose variant is bound to another workflow (myreview) is split only by that workflow's definition
describe('stage partition of myreview', () => {
  const myreview = parseDefinition(
    parse(
      fs.readFileSync(
        path.join(import.meta.dirname, '../fixtures/workflows/myreview.yaml'),
        'utf8',
      ),
    ),
    'myreview.yaml',
  );
  db.insert(workflowTable)
    .values({ id: 'myreview', name: myreview.name, definition: myreview, updatedAt: new Date() })
    .run();
  insertVariant(db, 'myreview-v', 'myreview');

  test('one scan, fix cycle; scan inside fix does not switch, fix again is counted; lfg and ic Skills are not markers', async () => {
    const base = loadSessionRows(db, '70e7a9b6-fdad-44c3-9b65-015ee2a0499c').main;
    const template = base.find((r) => r.toolCalls.some((c) => c.name === 'Skill'));
    const call = template?.toolCalls.find((c) => c.name === 'Skill');
    const last = base.at(-1);
    if (template === undefined || call === undefined || last === undefined) {
      throw new Error('27yz3d has no Skill call');
    }
    const names = ['scan', 'fix', 'scan', 'fix', 'report'];
    const extra = names.flatMap((name, i): RequestRow[] => {
      const at = last.timestamp.getTime() + (i + 1) * 60_000;
      return [
        {
          ...template,
          messageId: `${template.messageId}-review-${String(i)}`,
          seq: last.seq + 1 + i * 2,
          timestamp: new Date(at),
          toolCalls: [{ ...call, id: `${call.id}-review-${String(i)}`, input: { skill: name } }],
        },
        {
          ...last,
          messageId: `${last.messageId}-review-${String(i)}-work`,
          seq: last.seq + 2 + i * 2,
          timestamp: new Date(at + 1000),
        },
      ];
    });
    const id = randomUUID();
    insertSession(db, id, [...base, ...extra], null);
    // First split by lfg and ic (unbound); after binding, recomputed from the start by myreview only
    updateStages(db, id);
    expect((await stages(id)).workflows.map((w) => w.workflow)).toEqual(['lfg', 'ic']);
    db.update(sessions)
      .set({ variantId: 'myreview-v', variantBinding: 'manual' })
      .where(eq(sessions.id, id))
      .run();
    const report = await stages(id);
    expect(report.workflows.map((w) => [w.workflow, w.cycles.length])).toEqual([['myreview', 1]]);
    const cycle = report.workflows[0]?.cycles[0];
    expect([cycle?.label, cycle?.startSeq, cycle?.endSeq]).toEqual(['Round 1', 34, 43]);
    expect(views(cycle).map(([stage, status, s, e, n]) => [stage, status, s, e, n])).toEqual([
      ['scan', 'done', 34, 35, 1],
      ['fix', 'done', 36, 41, 2],
      ['report', 'active', 42, 43, 1],
    ]);
    expect(report.outside.mainRequests).toBe(34);
    expect(report).toEqual(stageReportOf([myreview], loadSessionRows(db, id), false));
  });

  test('interactive session: uses the variant of the latest process of its Live item; processes with the local machine configuration use lfg and ic', () => {
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
    const partition = () => sessionPartition(db, id).map((w) => w.id);
    processOf(null);
    processOf('myreview-v');
    expect(partition()).toEqual(['myreview']);
    processOf(null);
    expect(partition()).toEqual(['lfg', 'ic']);
    // A variant of a built-in workflow is also split by lfg and ic together
    processOf('stage-report-v');
    expect(partition()).toEqual(['lfg', 'ic']);
  });
});
