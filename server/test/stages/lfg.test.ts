import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { type ToolCall, userMessages } from '../../src/db/schema.js';
import {
  featureDir,
  LfgTracker,
  lfgOfflineBoundaries,
  lfgSnapshot,
  slugify,
} from '../../src/stages/lfg.js';
import { analyzeSession } from '../../src/stages/report.js';
import type { RequestRow } from '../../src/stages/rows.js';
import { insertSession, openTestDb } from './db.js';
import { ingestSample, SAMPLES, TEST_STAGE_MODEL } from './samples.js';

const VAULT = '/Users/linhaoz/Documents/Obsidian Vault';
const work = path.join(config.repoRoot, '.work', 'stages-lfg');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

const { db, close } = openTestDb();
afterAll(close);

describe('lfg 实时规则：vault 中真实 feature 目录', () => {
  // Stage Markers 1.4 的结果（.spikes/stage-markers/out/lfg-rules-vault.txt）
  const expected: [string, string, [boolean, boolean, string | null, boolean]][] = [
    ['Magi', 'optional-mcp-install', [true, true, null, true]],
    ['Magi', 'release-train-service', [false, true, null, false]],
    ['Magi', 'txe-workflow', [true, false, null, false]],
    ['Magi', 'ui-copy-guidelines', [false, true, null, false]],
    [
      'Tokun',
      'github-growth-dashboard',
      [true, true, 'Status: locked · 2026-09-29 · From: Research.md §6', true],
    ],
    ['Tokun', 'model-pool', [true, true, '状态： locked · 2026-09-18 · 来源： §6 规格', true]],
    ['Tokun', 'sub2api-ci-bazel-migration', [false, true, null, true]],
    ['Tokun', 'sub2api-ci-release-performance', [false, true, null, false]],
  ];

  test.each(expected)('Project %s/%s', (product, feature, [brief, research, lock, tickets]) => {
    const docs = lfgSnapshot(featureDir(VAULT, product, feature), feature);
    const doc = docs.research ?? docs.design;
    expect(docs.brief !== null).toBe(brief);
    expect(doc !== null).toBe(research);
    const line = docs.research?.planLockLine ?? docs.design?.planLockLine ?? null;
    if (lock === null) expect(line).toBeNull();
    else expect(line?.startsWith(lock)).toBe(true);
    expect(docs.tickets !== null).toBe(tickets);
  });

  test('feature 不符的文件不算', () => {
    const docs = lfgSnapshot(featureDir(VAULT, 'Tokun', 'model-pool'), 'other-run');
    expect(Object.values(docs).every((d) => d === null)).toBe(true);
  });

  test('首次出现就带锁定标记只算 research，改写后才算 plan', () => {
    const src = featureDir(VAULT, 'Tokun', 'github-growth-dashboard');
    const dir = path.join(work, 'live', 'github-growth-dashboard');
    fs.mkdirSync(dir, { recursive: true });
    const tracker = new LfgTracker(dir, 'github-growth-dashboard');
    const done = () =>
      Object.entries(tracker.observe().stages)
        .filter(([, d]) => d !== null)
        .map(([s]) => s);

    expect(done()).toEqual([]);
    fs.copyFileSync(path.join(src, 'Brief.md'), path.join(dir, 'Brief.md'));
    expect(done()).toEqual(['interview']);
    fs.copyFileSync(path.join(src, 'Research.md'), path.join(dir, 'Research.md'));
    expect(done()).toEqual(['interview', 'research']);
    expect(done()).toEqual(['interview', 'research']);
    fs.copyFileSync(path.join(src, 'Tickets.md'), path.join(dir, 'Tickets.md'));
    expect(tracker.observe().planLockMissing).toBe(true);
    fs.appendFileSync(path.join(dir, 'Research.md'), '\n- 2026-09-29 plan locked\n');
    const progress = tracker.observe();
    expect(progress.stages.plan?.planLockLine).toMatch(/^Status: locked/);
    expect(progress.planLockMissing).toBe(false);
  });

  test('slugify 与 wf obsidian 一致', () => {
    expect(slugify('Run_01ABC xyz')).toBe('run-01abc-xyz');
    expect(featureDir('/v', 'Magi Eval', 'run-1')).toBe('/v/Project Magi Eval/Features/run-1');
  });
});

// 离线规则：在 .work 下的 vault 中真实运行 wf obsidian，把命令与输出放进 Bash 调用
describe('lfg 离线规则：wf obsidian 边界调用', () => {
  const vault = path.join(work, 'vault');
  const ws = path.join(work, 'ws');
  fs.mkdirSync(path.join(vault, 'Project Magi Eval'), { recursive: true });
  for (const d of ['.interview', '.research', '.plan', '.ticketing']) {
    fs.mkdirSync(path.join(ws, d), { recursive: true });
  }

  const interview = ingestSample(db, SAMPLES.interview);
  const prs = ingestSample(db, SAMPLES.icPrs);
  // 真实的 Skill interview 请求（d93c4511 第 28 行）与两次 --dry-run（f0aca373 第 3708、3743 行）
  const skillRow = interview.main.find((r) =>
    r.toolCalls.some((c) => c.name === 'Skill' && interview.toolLine.get(c.id) === 28),
  );
  const dryRuns = prs.main.filter((r) =>
    r.toolCalls.some((c) => [3708, 3743].includes(prs.toolLine.get(c.id) ?? 0)),
  );
  const [template] = dryRuns;
  if (!skillRow || !template || dryRuns.length !== 2) {
    throw new Error('样本中找不到 Skill interview 或 dry-run 请求');
  }

  const bash = (command: string): RequestRow => {
    const stdout = execFileSync('/bin/sh', ['-c', command], { cwd: ws, encoding: 'utf8' });
    const call: ToolCall = {
      id: `toolu_${slugify(command).slice(0, 40)}`,
      name: 'Bash',
      input: { command, description: 'File the document in the vault' },
      result: stdout,
      resultChars: stdout.length,
      isError: false,
      spillPath: null,
      subagentId: null,
    };
    return { ...template, messageId: `${template.messageId}-${call.id}`, toolCalls: [call] };
  };

  const session = (feature: string, planSource: string): RequestRow[] => {
    const copy = (from: string, to: string) => {
      fs.copyFileSync(from, path.join(ws, to));
    };
    const tokun = (f: string) => path.join(featureDir(VAULT, 'Tokun', 'model-pool'), f);
    copy(tokun('Brief.md'), '.interview/brief.md');
    copy(tokun('Research.md'), '.research/research.md');
    copy(planSource, '.plan/research.md');
    copy(tokun('Tickets.md'), '.ticketing/tickets.md');
    const wf = (args: string) =>
      `wf obsidian ${args} --product "Magi Eval" --feature "${feature}" --vault "${vault}"`;
    const rows = [
      skillRow,
      ...dryRuns,
      bash(wf('--kind brief --file .interview/brief.md --title "Brief"')),
      bash(wf('--kind research --file .research/research.md --title "R — research"')),
      bash(wf('--kind research --file .plan/research.md --title "R — research" --replace')),
      bash(wf('--kind tickets --file .ticketing/tickets.md --title "R — tickets"')),
    ];
    return rows.map((r, seq) => ({ ...r, seq, agentId: null }));
  };

  const locked = path.join(featureDir(VAULT, 'Tokun', 'model-pool'), 'Research.md');
  const unlocked = path.join(featureDir(VAULT, 'Magi', 'optional-mcp-install'), 'Research.md');

  test('四个边界依次识别，dry-run 被排除', () => {
    const rows = session('run-offline-a', locked);
    const boundaries = lfgOfflineBoundaries(rows, ws);
    expect(boundaries.map((b) => [b.stage, b.seq])).toEqual([
      ['interview', 3],
      ['research', 4],
      ['plan', 5],
      ['ticketing', 6],
    ]);
    expect(boundaries[2]?.planLockLine).toMatch(/^状态： locked/);
    expect(boundaries[0]?.path).toBe(
      path.join(vault, 'Project Magi Eval/Features/run-offline-a/Brief.md'),
    );
  });

  test('--replace 写入的文件没有锁定标记时 plan 不算完成，报告标出未检测到锁定标记', async () => {
    const rows = session('run-offline-b', unlocked);
    expect(lfgOfflineBoundaries(rows, ws).map((b) => b.stage)).toEqual([
      'interview',
      'research',
      'ticketing',
    ]);
    const sessionId = 'lfg-offline-b';
    insertSession(db, sessionId, rows, ws);
    const report = await analyzeSession(db, sessionId, TEST_STAGE_MODEL);
    expect(report.ic).toEqual([]);
    expect(report.checks.count).toBe(0);
    // dispatch gate 还没有回答：这一轮没有结束，ticketing 到 session 末尾
    expect(report.lfg).toHaveLength(1);
    const cycle = report.lfg[0];
    expect(cycle).toMatchObject({
      index: 1,
      label: 'run-offline-b',
      startSeq: 0,
      endSeq: null,
    });
    const stages = cycle?.stages ?? [];
    expect(stages.map((v) => [v.stage, v.status, v.startSeq, v.endSeq, v.method])).toEqual([
      ['interview', 'done', 0, 3, 'artifact'],
      ['research', 'done', 4, 4, 'artifact'],
      ['plan', 'skipped', 5, 4, 'artifact'],
      ['ticketing', 'done', 5, 6, 'artifact'],
    ]);
    expect(stages[2]?.evidence).toEqual({ note: '未检测到锁定标记' });
    expect(stages[0]?.stats.toolCalls).toEqual({ Skill: 1, Bash: 3 });
    expect(report.outside.requests).toBe(0);
  });

  test('dispatch gate 回答之后这一轮结束，下一个 lfg 标志开始第二轮', async () => {
    const t0 = Date.parse('2026-10-09T08:00:00.000Z');
    const at = (seq: number) => new Date(t0 + seq * 1000);
    const first = session('run-offline-d', locked);
    const [reply] = dryRuns;
    if (!reply) throw new Error('缺少模板请求');
    const second = session('run-offline-e', locked);
    const rows = [
      ...first,
      {
        ...reply,
        messageId: `${reply.messageId}-gate-reply`,
        text: '好的，不派发。',
        toolCalls: [],
      },
      ...second.map((r) => ({ ...r, messageId: `${r.messageId}-second` })),
    ].map((r, seq) => ({ ...r, seq, timestamp: at(seq) }));
    const sessionId = 'lfg-offline-cycles';
    insertSession(db, sessionId, rows, ws);
    // dispatch gate 的回答在 Tickets.md 写出（seq 6）之后，第二个想法在回答处理完（seq 7）之后
    for (const [i, [seconds, text]] of [
      [6.5, '不派发，到此结束。'],
      [7.5, '再做一个想法'],
    ].entries()) {
      db.insert(userMessages)
        .values({
          sessionId,
          agentId: null,
          uuid: `gate-${String(i)}`,
          kind: 'user',
          timestamp: new Date(t0 + Number(seconds) * 1000),
          text: String(text),
        })
        .run();
    }
    const report = await analyzeSession(db, sessionId, TEST_STAGE_MODEL);
    expect(report.lfg.map((c) => [c.index, c.label, c.startSeq, c.endSeq])).toEqual([
      [1, 'run-offline-d', 0, 7],
      [2, 'run-offline-e', 8, null],
    ]);
    expect(report.lfg[0]?.stages.map((v) => [v.stage, v.status, v.startSeq, v.endSeq])).toEqual([
      ['interview', 'done', 0, 3],
      ['research', 'done', 4, 4],
      ['plan', 'done', 5, 5],
      ['ticketing', 'done', 6, 7],
    ]);
    expect(report.lfg[1]?.stages.map((v) => [v.stage, v.status])).toEqual([
      ['interview', 'done'],
      ['research', 'done'],
      ['plan', 'done'],
      ['ticketing', 'done'],
    ]);
    expect(report.outside.requests).toBe(0);
  });

  test('写出的文件被删除后不算边界', () => {
    const rows = session('run-offline-c', locked);
    fs.rmSync(path.join(vault, 'Project Magi Eval/Features/run-offline-c/Tickets.md'));
    expect(lfgOfflineBoundaries(rows, ws).map((b) => b.stage)).toEqual([
      'interview',
      'research',
      'plan',
    ]);
  });
});
