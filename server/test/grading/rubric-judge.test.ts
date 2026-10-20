import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { itemKey, judgeSchema, readJudgment } from '../../src/grading/rubric-judge.js';
import { loadTask, syncTasks, withRubric } from '../../src/tasks/loader.js';
import { openTestDb } from '../stages/db.js';

// 不调用模型：respond 参数的读取与校验。真实调用见 lfg-judge.test.ts
const tasksDir = fileURLToPath(new URL('../fixtures/lfg-tasks/', import.meta.url));
const { db, close } = openTestDb();
syncTasks(db, tasksDir);
const task = withRubric(loadTask(db, 'optional-mcp-install'));
close();
const tickets = task.rubric.find((g) => g.artifact === 'tickets');
if (tickets === undefined) throw new Error('fixture 没有 tickets rubric');

// .work/w23 统计中 opus 对 fixture tickets 的一次真实回答（第一条），其余条目的 reasoning 取同一轮的回答
const realReasoning =
  '“Reconciliation”表列出 TXE-2076、TXE-1908、TXE-1881、TXE-1944 四张已有工单，逐条写了关系和“why it is not this”，还说明没有需要更新或冲突的工单。';

function answer(overrides: Record<number, { reasoning: string; score: number }> = {}) {
  return Object.fromEntries(
    (tickets?.items ?? []).map((item, i) => [
      itemKey(i),
      overrides[i] ?? { reasoning: `${item.id}：${realReasoning}`, score: item.maxScore },
    ]),
  );
}

describe('judge 按条目编号作答', () => {
  test('schema 的键为 item_1…item_n，按编号对应回 rubric 的 itemId 与 criterion', () => {
    const schema = judgeSchema(tickets);
    expect(Object.keys(schema.shape)).toEqual(tickets.items.map((_, i) => `item_${String(i + 1)}`));
    const items = readJudgment(
      tickets,
      schema.parse(answer({ 1: { reasoning: '只有一张工单写了依赖。', score: 1 } })),
    );
    expect(items.map((i) => i.itemId)).toEqual(tickets.items.map((i) => i.id));
    expect(items[0]).toMatchObject({ itemId: 't1', score: 3, maxScore: 3 });
    expect(items[1]).toMatchObject({
      itemId: tickets.items[1]?.id,
      criterion: tickets.items[1]?.criterion,
      score: 1,
      reasoning: '只有一张工单写了依赖。',
    });
  });

  test('只返回第一个条目时由 schema 拒绝', () => {
    const only = { item_1: { reasoning: realReasoning, score: 3 } };
    expect(() => judgeSchema(tickets).parse(only)).toThrow(/item_2/);
  });

  test('空的 reasoning 由 schema 拒绝', () => {
    expect(() => judgeSchema(tickets).parse(answer({ 2: { reasoning: '', score: 2 } }))).toThrow(
      /too_small|>=1/,
    );
  });

  test('reasoning 是占位内容时抛错，正文中出现 placeholder、todo 不受影响', () => {
    for (const filler of ['placeholder', '占位', '待填', ' ', ': ', '.', 'x', 'N/A', 'TODO']) {
      expect(() => readJudgment(tickets, answer({ 0: { reasoning: filler, score: 0 } }))).toThrow(
        `judge 给 t1 的 reasoning 是占位内容：${JSON.stringify(filler)}`,
      );
    }
    const normal = '工单写了 todo 列表的接口，没有写占位文案与 placeholder 的内容。';
    expect(
      readJudgment(tickets, answer({ 0: { reasoning: normal, score: 1 } }))[0]?.reasoning,
    ).toBe(normal);
  });

  test('reasoning 没有写完（不以句末标点结束）时抛错', () => {
    // .work/w23 统计中 sonnet 的真实回答：第一个条目写到一半，其余条目为「占位」
    for (const cut of ['产物未直接声称存在一个', '每张工单只有一句', 'Decision ledger 明确：']) {
      expect(() => readJudgment(tickets, answer({ 0: { reasoning: cut, score: 0 } }))).toThrow(
        `judge 给 t1 的 reasoning 没有写完：${JSON.stringify(cut)}`,
      );
    }
    for (const complete of [
      '产物写明了依赖（TXE-2105→TXE-2106）。',
      '对照表列出了四张工单，并说明了「why it is not this」。',
      'Tickets.md 写明 --force 不解除跳过（见 §2）。',
      'All four tickets are listed with their reasons.',
    ]) {
      expect(
        readJudgment(tickets, answer({ 0: { reasoning: complete, score: 1 } }))[0]?.reasoning,
      ).toBe(complete);
    }
  });

  test('分数越界时抛错', () => {
    expect(() =>
      readJudgment(tickets, answer({ 0: { reasoning: realReasoning, score: 4 } })),
    ).toThrow('judge 给 t1 的分数 4 超出 0..3');
    expect(() =>
      readJudgment(tickets, answer({ 0: { reasoning: realReasoning, score: -1 } })),
    ).toThrow('judge 给 t1 的分数 -1 超出 0..3');
  });
});
