import { and, eq, gt } from 'drizzle-orm';
import { afterAll, describe, expect, test } from 'vitest';
import { stageChecks } from '../../src/db/schema.js';
import {
  advanceIc,
  batchIndexOf,
  behaviourLines,
  behavioursOf,
  checkVerdict,
  type IcState,
  summarize,
} from '../../src/stages/ic.js';
import { openTestDb } from './db.js';
import {
  ingestSample,
  mainRowsInLines,
  SAMPLES,
  type Sample,
  TEST_STAGE_MODEL,
} from './samples.js';

const { db, close } = openTestDb();
afterAll(close);

const prs = ingestSample(db, SAMPLES.icPrs);
const research = ingestSample(db, SAMPLES.research);

// 实时入口 advanceIc 对样本的一段行判定；只统计这一段写入的 stage_checks
async function judgeSegment(name: string, s: Sample, from: number, to: number, initial: IcState) {
  const before = db.select().from(stageChecks).all().length;
  const behaviours = behavioursOf(mainRowsInLines(s, from, to));
  const result = await advanceIc(db, {
    sessionId: s.sessionId,
    current: initial,
    behaviours,
    model: TEST_STAGE_MODEL,
  });
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
  console.log(
    `ic ${name} 边界`,
    JSON.stringify(
      result.boundaries.map((b) => [b.cycle, b.stage, s.toolLine.get(b.toolCallId), b.summary]),
    ),
  );
  // 边界换算成 tool_use 所在的 jsonl 行号与判定方式，与 Stage Markers 2.6 对照；离开流程单独返回
  const lines = Object.fromEntries(
    result.boundaries
      .filter((b) => b.stage !== 'outside')
      .map((b) => [b.stage, s.toolLine.get(b.toolCallId)]),
  );
  const methods = Object.fromEntries(
    result.boundaries.filter((b) => b.stage !== 'outside').map((b) => [b.stage, b.method]),
  );
  const leave = result.boundaries.find((b) => b.stage === 'outside');
  return { result, lines, methods, leave, checks };
}

describe('ic 判定（真实模型）', () => {
  // open-pr 都是 Skill 调用；fix-pr 在 #72、#78 是 Skill 调用，#77 没有 fix-pr Skill，由模型判定 watcher 启动的那一条。
  // 这三段都没有运行 /acceptance：Skill open-pr 越过 acceptance，acceptance 没有边界。
  // rfr：ready-for-review 可接受的起点。Stage Markers 2.6（Haiku）为 gh pr ready 那一条；
  // PR #77 中 Sonnet 也会判在第 9100 行（停掉 watcher 并 gh pr view 77 查看 PR 状态），同样是 ready-for-review 的核对动作
  test.each([
    ['pr72', 5700, 6160, { 'open-pr': 5811, 'fix-pr': 5883, fixPrMethod: 'skill', rfr: [6153] }],
    [
      'pr77',
      8300,
      9140,
      { 'open-pr': 8397, 'fix-pr': 8430, fixPrMethod: 'llm', rfr: [9121, 9100] },
    ],
    [
      'pr78',
      12700,
      13700,
      { 'open-pr': 12802, 'fix-pr': 12921, fixPrMethod: 'skill', rfr: [13678] },
    ],
  ])(
    'f0aca373 %s 从 implement 开始得到 Stage Markers 2.6 的边界',
    async (name, from, to, expected) => {
      const { result, lines, methods, leave, checks } = await judgeSegment(
        name,
        prs,
        from,
        to,
        'implement',
      );
      expect(lines).toMatchObject({
        'open-pr': expected['open-pr'],
        'fix-pr': expected['fix-pr'],
      });
      expect(lines.acceptance).toBeUndefined();
      expect(methods).toMatchObject({
        'open-pr': 'skill',
        'fix-pr': expected.fixPrMethod,
        'ready-for-review': 'llm',
      });
      expect(expected.rfr).toContain(lines['ready-for-review']);
      // 从阶段中开始的调用，边界都属于已在进行的第 0 轮
      expect(result.boundaries.every((b) => b.cycle === 0)).toBe(true);
      // 离开流程只会发生在 ready-for-review 之后，或与 gh pr ready 在同一条命令里（之后直接合并）
      if (leave !== undefined) {
        expect(prs.toolLine.get(leave.toolCallId)).toBeGreaterThanOrEqual(
          lines['ready-for-review'] ?? 0,
        );
        expect(result.stage).not.toBe('ready-for-review');
      }
      // 每次模型调用都写了 stage_checks，Skill 调用定的边界不调用模型；回答"是"的次数等于模型判定的边界数，
      // 加上离开之后在同一条上又判为 ready-for-review、并入刚离开那一轮（inclusive）的次数
      const merged = checks.filter(
        (c) =>
          c.entered &&
          c.currentStage === 'outside' &&
          leave?.inclusive === true &&
          c.enteredAtSeq === leave.seq,
      ).length;
      expect(checks.filter((c) => c.entered)).toHaveLength(
        result.boundaries.filter((b) => b.method === 'llm').length + merged,
      );
      expect(checks.every((c) => c.costUsd > 0 && c.inputTokens > 0)).toBe(true);
    },
    300_000,
  );

  test('f0aca373 pr72 从流程外开始：Skill open-pr 开始一轮，ready-for-review 后离开', async () => {
    const { result, lines, methods, leave } = await judgeSegment(
      'pr72-outside',
      prs,
      5700,
      6400,
      'outside',
    );
    expect(lines['open-pr']).toBe(5811);
    expect(lines['fix-pr']).toBe(5883);
    expect(lines['ready-for-review']).toBe(6153);
    expect(methods).toMatchObject({ 'open-pr': 'skill', 'fix-pr': 'skill' });
    expect(result.boundaries[0]?.cycle).toBe(1);
    expect(leave).toBeDefined();
    expect(prs.toolLine.get(leave?.toolCallId ?? '')).toBeGreaterThanOrEqual(6153);
  }, 300_000);

  test('反例：9f4adf2d 调研 session 从流程外开始不进入任何一轮', async () => {
    const { result, checks } = await judgeSegment('neg-research', research, 1, 1200, 'outside');
    expect(result.boundaries).toEqual([]);
    expect(result.stage).toBe('outside');
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => !c.entered && c.enteredAtSeq === null)).toBe(true);
  }, 300_000);

  test('反例：f0aca373 第 2000–3300 行的辩论从流程外开始不进入任何一轮', async () => {
    const { result } = await judgeSegment('neg-debate', prs, 2000, 3300, 'outside');
    expect(result.boundaries).toEqual([]);
    expect(result.stage).toBe('outside');
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

  test('只有 tool 调用依次编号，回复文字不编号', () => {
    const lines = behaviourLines(behaviours);
    const tools = behaviours.filter((b) => b.kind === 'tool').length;
    expect(lines.filter((l) => l.startsWith('['))).toHaveLength(tools);
    expect(lines.filter((l) => l.startsWith('    回复: '))).toHaveLength(behaviours.length - tools);
    const textIndex = behaviours.findIndex((b) => b.kind === 'text');
    expect(textIndex).toBeGreaterThan(-1);
    expect(behaviours[batchIndexOf(behaviours, 0)]?.kind).toBe('tool');
    expect(lines[batchIndexOf(behaviours, tools - 1)]).toMatch(
      new RegExp(`^\\[${String(tools - 1)}\\] `),
    );
  });

  test('checkVerdict 拒绝不一致与超出 tool 调用数的 verdict', () => {
    const tools = behaviours.filter((b) => b.kind === 'tool').length;
    expect(() => checkVerdict({ advanced: true, first_index: null }, behaviours)).toThrow(/不一致/);
    expect(() => checkVerdict({ advanced: false, first_index: 0 }, behaviours)).toThrow(/不一致/);
    expect(() => checkVerdict({ advanced: true, first_index: tools }, behaviours)).toThrow(/超出/);
    expect(checkVerdict({ advanced: true, first_index: tools - 1 }, behaviours).advanced).toBe(
      true,
    );
  });
});
