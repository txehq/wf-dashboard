import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { structuredRequest } from '../../src/llm/client.js';
import {
  criteriaDraftRequest,
  criteriaSectionItemCount,
  readCriteriaDraft,
} from '../../src/tasks/criteria-draft.js';
import { RubricDraftOutput } from '../../src/tasks/schema.js';

// 真实数据：TXE-3777 的正文，以及 W33 实测中 judge 的两次真实回答（TXE-3777 拆成 38 条；rubric 草稿的 id 大写）
const fixture = (name: string) => new URL(`../fixtures/llm/${name}`, import.meta.url);
const body = fs.readFileSync(fixture('TXE-3777.body.md'), 'utf8');
const split = JSON.parse(fs.readFileSync(fixture('criteria-draft-split.input.json'), 'utf8')) as {
  criteria: { text: string; quote: string }[];
};
const uppercase: unknown = JSON.parse(
  fs.readFileSync(fixture('rubric-draft-uppercase.input.json'), 'utf8'),
);

describe('验收标准一节的列表项数', () => {
  it('TXE-3777：## Acceptance criteria 一节有 8 个列表项', () => {
    expect(criteriaSectionItemCount(body)).toBe(8);
  });

  it('加粗段落标题、嵌套列表只数顶层、节在下一个标题处结束', () => {
    const bold = [
      '修复 release 标签。',
      '',
      '**Acceptance criteria**',
      '',
      '* AC1 接受 `@`',
      '  * 子项不单独计数',
      '* AC2 接受 `+`',
      '',
      '**Notes**',
      '',
      '* 不是验收标准',
    ].join('\n');
    expect(criteriaSectionItemCount(bold)).toBe(2);
    const heading = ['## 验收标准：', '', '1. 一', '2. 二', '', '### 细节', '', '- 子节仍在本节内', '', '## 其他', '', '- 不算'].join('\n');
    expect(criteriaSectionItemCount(heading)).toBe(3);
  });

  it('没有这一节，或这一节下面没有列表：null；两个这样的节时抛错', () => {
    expect(criteriaSectionItemCount(body.split('\n## Scope')[0] ?? '')).toBeNull();
    expect(criteriaSectionItemCount('## Acceptance criteria\n\n按工单正文实现。\n')).toBeNull();
    expect(() =>
      criteriaSectionItemCount('## 验收标准\n\n- 一\n\n## Acceptance\n\n- 二\n'),
    ).toThrow('正文中有 2 个验收标准一节，不能确定以哪一节为准');
  });

  it('judge 的真实回答把 TXE-3777 拆成 38 条：以原文失败', () => {
    expect(split.criteria).toHaveLength(38);
    expect(() => readCriteriaDraft(body, split)).toThrow(
      'judge 给出 38 条验收标准，正文的验收标准一节有 8 个列表项',
    );
  });

  it('逐条照原文取出的 8 条：通过', () => {
    const section = body.split('## Acceptance criteria')[1]?.split('\n## ')[0] ?? '';
    const items = section
      .split('\n')
      .filter((line) => line.startsWith('- [ ] '))
      .map((line) => line.slice('- [ ] '.length));
    const read = readCriteriaDraft(body, { criteria: items.map((text) => ({ text, quote: text })) });
    expect(read).toHaveLength(8);
  });
});

describe('rubric 草稿的校验', () => {
  it('judge 的真实回答：id 为大写 B1…、每组 9 条以上，以 zod 的原文失败', () => {
    const result = RubricDraftOutput.safeParse(uppercase);
    expect(result.success).toBe(false);
    const issues = result.error?.issues ?? [];
    expect(issues.some((i) => i.code === 'invalid_format' && i.path.at(-1) === 'id')).toBe(true);
    expect(issues.some((i) => i.code === 'too_big' && i.path.at(-1) === 'items')).toBe(true);
  });

  it('每组 4 到 8 条，id 为小写字母开头', () => {
    const group = (n: number, prefix = 'b') => ({
      artifact: 'brief' as const,
      items: Array.from({ length: n }, (_, i) => ({
        id: `${prefix}${String(i + 1)}`,
        criterion: '产物是否写明使用场景。',
        maxScore: 3,
      })),
    });
    expect(RubricDraftOutput.safeParse({ rubric: [group(4)] }).success).toBe(true);
    expect(RubricDraftOutput.safeParse({ rubric: [group(8)] }).success).toBe(true);
    expect(RubricDraftOutput.safeParse({ rubric: [group(3)] }).success).toBe(false);
    expect(RubricDraftOutput.safeParse({ rubric: [group(9)] }).success).toBe(false);
    expect(RubricDraftOutput.safeParse({ rubric: [group(4, 'B')] }).success).toBe(false);
  });

  it('两个 schema 都能生成 strict tool 的请求', () => {
    expect(structuredRequest(criteriaDraftRequest('t', body, 'm')).tools).toHaveLength(1);
    expect(
      structuredRequest({ model: 'm', system: 's', user: 'u', schema: RubricDraftOutput, maxTokens: 1 })
        .tools,
    ).toHaveLength(1);
  });
});
