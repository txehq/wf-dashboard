import { afterAll, describe, expect, it } from 'vitest';
import { closeLinearClient, readIssueForImport } from '../../src/external/linear.js';
import { draftCriteria, readCriteriaDraft } from '../../src/tasks/criteria-draft.js';

afterAll(closeLinearClient);

// 真实 Linear（只读取）与真实 gateway 上的 judge 模型；工单为 `/lfg 做一个计算器` 建出的 TXE-3777
describe('judge 确定验收标准', { timeout: 5 * 60_000 }, () => {
  it('TXE-3777：有 ## Acceptance criteria 一节，逐条与原文一致', async () => {
    const issue = await readIssueForImport('TXE-3777');
    // 这一节是 8 个任务列表项
    const section = issue.description.split('## Acceptance criteria')[1]?.split('\n## ')[0] ?? '';
    const expected = section
      .split('\n')
      .filter((line) => line.startsWith('- [ ] '))
      .map((line) => line.slice('- [ ] '.length));
    expect(expected).toHaveLength(8);
    const draft = await draftCriteria(issue.title, issue.description);
    expect(draft.criteria.map((c) => c.text)).toEqual(expected);
    for (const c of draft.criteria) expect(issue.description).toContain(c.quote);
    expect(draft.costUsd).toBeGreaterThan(0);
    console.log(
      `TXE-3777：${String(draft.criteria.length)} 条，${draft.model}，输入 ${String(draft.inputTokens)} 输出 ${String(draft.outputTokens)} token，花费 $${draft.costUsd.toFixed(4)}`,
    );
  });

  it('没有验收标准一节：TXE-3777 正文去掉这一节之后，从其余内容整理出条目，每个 quote 都在正文中', async () => {
    const issue = await readIssueForImport('TXE-3777');
    const [before, after] = issue.description.split('## Acceptance criteria');
    const rest = after?.slice(after.indexOf('\n## ')) ?? '';
    const body = `${before ?? ''}${rest}`;
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
