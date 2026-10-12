import { afterAll, describe, expect, it } from 'vitest';
import { closeLinearClient, readIssueForImport } from '../../src/external/linear.js';
import { draftCriteria, readCriteriaDraft } from '../../src/tasks/criteria-draft.js';

afterAll(closeLinearClient);

// 真实 Linear（只读取）与真实 gateway 上的 judge 模型；工单为 `/lfg 做一个计算器` 建出的 TXE-3777
describe('judge 确定验收标准', { timeout: 5 * 60_000 }, () => {
  // 能证明"有验收标准一节时逐条照原文、其他节不加条目"的最小正文：TXE-3777 的真实文字中，Scope 的两个列表项
  // 加验收标准一节的前三项（1.2 带分号、每项带 — verify:，W33 中 opus 正是从这两处拆开与加条目）
  it('TXE-3777 的 Scope 两项与验收标准三项：照原文取出 3 条', async () => {
    const issue = await readIssueForImport('TXE-3777');
    const lines = issue.description.split('\n');
    const scope = lines.filter((l) => l.startsWith('  * ')).slice(0, 2);
    const criteria = lines.filter((l) => l.startsWith('- [ ] ')).slice(0, 3);
    const body = ['## Scope', '', ...scope, '', '## Acceptance criteria', '', ...criteria].join('\n');
    const draft = await draftCriteria(issue.title, body);
    expect(draft.criteria.map((c) => c.text)).toEqual(criteria.map((l) => l.slice('- [ ] '.length)));
    for (const c of draft.criteria) expect(body).toContain(c.quote);
    console.log(
      `TXE-3777 最小正文：${String(draft.criteria.length)} 条，${draft.model}，输入 ${String(draft.inputTokens)} 输出 ${String(draft.outputTokens)} token，花费 $${draft.costUsd.toFixed(4)}`,
    );
  });

  it('没有验收标准一节：TXE-3777 正文的 Background 与 Goals 两节，从中整理出条目，每个 quote 都在正文中', async () => {
    const issue = await readIssueForImport('TXE-3777');
    // 只取前两节（真实正文的一部分，约 1000 个输入 token）：没有验收标准一节的正文
    const body = issue.description.split('\n## Scope')[0] ?? '';
    expect(body).toContain('## Goals');
    expect(body).not.toMatch(/acceptance criteria|验收标准/i);
    const draft = await draftCriteria(issue.title, body);
    expect(draft.criteria.length).toBeGreaterThan(0);
    for (const c of draft.criteria) {
      expect(body).toContain(c.quote);
      expect(c.text.length).toBeGreaterThan(5);
    }
    console.log(
      `TXE-3777 去掉验收标准一节：${String(draft.criteria.length)} 条，${draft.model}，输入 ${String(draft.inputTokens)} 输出 ${String(draft.outputTokens)} token，花费 $${draft.costUsd.toFixed(4)}`,
    );
    for (const c of draft.criteria) console.log(`- ${c.text}\n  quote: ${c.quote}`);
  });

  it('quote 不是正文的原文、text 是占位内容时以原文抛错', () => {
    const body = '构建产物里不能有任何指向外部的地址。';
    expect(() =>
      readCriteriaDraft(body, { criteria: [{ text: '产物不引用外部地址', quote: '没有外部地址' }] }),
    ).toThrow('judge 给第 1 条验收标准的 quote 不是正文的原文："没有外部地址"');
    expect(() =>
      readCriteriaDraft(body, { criteria: [{ text: 'placeholder', quote: '指向外部的地址' }] }),
    ).toThrow('judge 给第 1 条验收标准的 text 是占位内容');
    expect(
      readCriteriaDraft(body, { criteria: [{ text: '产物不引用外部地址', quote: '指向外部的地址' }] }),
    ).toEqual([{ text: '产物不引用外部地址', quote: '指向外部的地址' }]);
  });
});
