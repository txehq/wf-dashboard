import { and, eq, gt } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { stageChecks } from '../../src/db/schema.js';
import { advanceIc, behavioursOf, checkVerdict, summarize } from '../../src/stages/ic.js';
import type { IcStage } from '../../src/stages/workflow.js';
import { openTestDb } from './db.js';
import { ingestSample, mainRowsInLines, SAMPLES, type Sample } from './samples.js';

const { db, close } = openTestDb();
afterAll(close);

const prs = ingestSample(db, SAMPLES.icPrs);
const research = ingestSample(db, SAMPLES.research);

// 实时入口 advanceIc 对样本的一段行判定；只统计这一段写入的 stage_checks
async function judgeSegment(name: string, s: Sample, from: number, to: number, initial: IcStage) {
  const before = db.select().from(stageChecks).all().length;
  const behaviours = behavioursOf(mainRowsInLines(s, from, to));
  const result = await advanceIc(db, { sessionId: s.sessionId, current: initial, behaviours });
  const checks = db
    .select()
    .from(stageChecks)
    .where(and(eq(stageChecks.sessionId, s.sessionId), gt(stageChecks.id, before)))
    .all();
  const cost = {
    calls: checks.length,
    inputTokens: checks.reduce((n, c) => n + c.inputTokens, 0),
    outputTokens: checks.reduce((n, c) => n + c.outputTokens, 0),
    costUsd: checks.reduce((n, c) => n + c.costUsd, 0),
  };
  console.log(`ic ${name}: ${String(behaviours.length)} 条行为`, JSON.stringify(cost));
  // 边界换算成 tool_use 所在的 jsonl 行号，与 Stage Markers 2.6 对照
  const lines = Object.fromEntries(
    result.boundaries.map((b) => [b.stage, s.toolLine.get(b.toolCallId)]),
  );
  return { result, lines, checks };
}

describe('ic 判定（真实 Haiku）', () => {
  test.each([
    ['pr72', 5700, 6160, { acceptance: 5811, 'open-pr': 5811, 'fix-pr': 5883, rfr: 6153 }],
    ['pr77', 8300, 9140, { acceptance: 8397, 'open-pr': 8397, 'fix-pr': 8430, rfr: 9121 }],
    ['pr78', 12700, 13700, { acceptance: 12802, 'open-pr': 12802, 'fix-pr': 12921, rfr: 13678 }],
  ])(
    'f0aca373 %s 从 implement 开始得到 Stage Markers 2.6 的边界',
    async (name, from, to, expected) => {
      const { result, lines, checks } = await judgeSegment(name, prs, from, to, 'implement');
      expect(result.stage).toBe('ready-for-review');
      expect(lines).toEqual({
        acceptance: expected.acceptance,
        'open-pr': expected['open-pr'],
        'fix-pr': expected['fix-pr'],
        'ready-for-review': expected.rfr,
      });
      // 每次调用都写了 stage_checks，前进的次数等于边界数
      expect(checks.filter((c) => c.entered)).toHaveLength(4);
      expect(checks.every((c) => c.costUsd > 0 && c.inputTokens > 0)).toBe(true);
    },
    300_000,
  );

  test('反例：9f4adf2d 调研 session 从 claim 开始不前进', async () => {
    const { result, checks } = await judgeSegment('neg-research', research, 1, 1200, 'claim');
    expect(result.boundaries).toEqual([]);
    expect(result.stage).toBe('claim');
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => !c.entered && c.enteredAtSeq === null)).toBe(true);
  }, 300_000);

  test('反例：f0aca373 第 2000–3300 行的辩论从 implement 开始不前进', async () => {
    const { result } = await judgeSegment('neg-debate', prs, 2000, 3300, 'implement');
    expect(result.boundaries).toEqual([]);
    expect(result.stage).toBe('implement');
  }, 300_000);
});

describe('行为条目与 verdict 约束', () => {
  const behaviours = behavioursOf(mainRowsInLines(prs, 5700, 6160));

  test('Skill 调用的摘要与截断', () => {
    const skill = behaviours.find((b) => b.kind === 'tool' && b.name === 'Skill');
    expect(skill && summarize(skill)).toMatch(/^Skill: open-pr /);
    const long = behaviours.find((b) => Array.from(summarize(b)).length === 301);
    expect(long && summarize(long).endsWith('…')).toBe(true);
    expect(behaviours.every((b) => !/\s{2}/.test(summarize(b)))).toBe(true);
  });

  test('checkVerdict 拒绝不一致、越界与指向回复文字的 verdict', () => {
    const textIndex = behaviours.findIndex((b) => b.kind === 'text');
    const toolIndex = behaviours.findIndex((b) => b.kind === 'tool');
    expect(() => checkVerdict({ advanced: true, first_index: null }, behaviours)).toThrow(/不一致/);
    expect(() => checkVerdict({ advanced: false, first_index: 0 }, behaviours)).toThrow(/不一致/);
    expect(() =>
      checkVerdict({ advanced: true, first_index: behaviours.length }, behaviours),
    ).toThrow(/超出/);
    expect(() => checkVerdict({ advanced: true, first_index: textIndex }, behaviours)).toThrow(
      /回复文字/,
    );
    expect(checkVerdict({ advanced: true, first_index: toolIndex }, behaviours).advanced).toBe(
      true,
    );
  });
});
