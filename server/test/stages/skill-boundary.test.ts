import { afterAll, describe, expect, test } from 'vitest';
import {
  type Behaviour,
  behavioursOf,
  type IcBoundary,
  type IcState,
  skillAdvance,
  summarize,
} from '../../src/stages/ic.js';
import { icCycle } from '../../src/stages/report.js';
import { openTestDb } from './db.js';
import { ingestSample, mainRowsInLines, SAMPLES } from './samples.js';

const { db, close } = openTestDb();
afterAll(close);

const prs = ingestSample(db, SAMPLES.icPrs);
const pr72 = behavioursOf(mainRowsInLines(prs, 5700, 6160));
const pr77 = behavioursOf(mainRowsInLines(prs, 8300, 9140));

type Tool = Extract<Behaviour, { kind: 'tool' }>;

function hitOf(state: IcState, batch: Behaviour[]): { stage: string; tool: Tool } | null {
  const hit = skillAdvance(state, batch);
  if (hit === null) return null;
  const tool = batch[hit.index];
  if (tool?.kind !== 'tool') throw new Error('Skill 调用必须是 tool 调用');
  return { stage: hit.stage, tool };
}

const lineOf = (state: IcState, batch: Behaviour[]) => {
  const hit = hitOf(state, batch);
  return hit === null ? null : [hit.stage, prs.toolLine.get(hit.tool.toolCallId)];
};

describe('ic 的确定性边界（Contracts 5）', () => {
  test('只匹配当前状态之后的 ic 阶段的 Skill 调用', () => {
    // PR #72：Skill open-pr 5811、Skill fix-pr 5883、Skill review-pr 5923（不是 ic 阶段）
    expect(lineOf('outside', pr72)).toEqual(['open-pr', 5811]);
    expect(lineOf('implement', pr72)).toEqual(['open-pr', 5811]);
    expect(lineOf('open-pr', pr72)).toEqual(['fix-pr', 5883]);
    expect(lineOf('fix-pr', pr72)).toBeNull();
    expect(lineOf('ready-for-review', pr72)).toBeNull();
    // PR #77 没有 fix-pr Skill：open-pr 之后没有确定性边界
    expect(lineOf('implement', pr77)).toEqual(['open-pr', 8397]);
    expect(lineOf('open-pr', pr77)).toBeNull();
  });

  test('Skill 调用越过的阶段为 skipped，判定方式与证据是那次 Skill 调用', () => {
    const first = pr77.find((b): b is Tool => b.kind === 'tool');
    const skill = hitOf('implement', pr77);
    if (first === undefined || skill === null) throw new Error('样本中缺少 tool 调用');
    const boundary = (b: Tool, stage: IcState, method: IcBoundary['method']): IcBoundary => ({
      cycle: 1,
      stage,
      seq: b.seq,
      toolCallId: b.toolCallId,
      summary: summarize(b),
      method,
    });
    const lastSeq = pr77[pr77.length - 1]?.seq ?? -1;
    const spans = icCycle(
      [boundary(first, 'implement', 'llm'), boundary(skill.tool, 'open-pr', 'skill')],
      undefined,
      lastSeq,
    );
    const at = skill.tool.seq;
    expect(spans.map((s) => [s.stage, s.status, s.startSeq, s.endSeq, s.method])).toEqual([
      ['claim', 'skipped', first.seq, first.seq - 1, 'llm'],
      ['readiness', 'skipped', first.seq, first.seq - 1, 'llm'],
      ['implement', 'done', first.seq, at - 1, 'llm'],
      ['acceptance', 'skipped', at, at - 1, 'skill'],
      ['open-pr', 'active', at, lastSeq, 'skill'],
      ['fix-pr', 'not-reached', null, null, 'llm'],
      ['ready-for-review', 'not-reached', null, null, 'llm'],
    ]);
    const evidence = { seq: at, toolCallId: skill.tool.toolCallId, summary: summarize(skill.tool) };
    expect(spans[3]?.evidence).toEqual(evidence);
    expect(spans[4]?.evidence).toEqual(evidence);
    expect(summarize(skill.tool)).toMatch(/^Skill: open-pr/);
    // 这一轮之前的阶段（从 implement 开始）没有证据
    expect(spans[0]?.evidence).toBeNull();
  });
});
