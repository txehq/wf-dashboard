import { describe, expect, it } from 'vitest';
import { extractAcceptanceCriteria } from '../../src/tasks/acceptance-criteria.js';

describe('验收标准的提取（mdast）', () => {
  it('## Acceptance criteria 下的任务列表：去掉勾选框，保留行内代码，到下一个同级标题为止', () => {
    const body = [
      '修复 `formatMoney`。',
      '',
      '## Acceptance criteria',
      '',
      "- [ ] `formatMoney(1234, 'JPY')` 为 `¥1,234`",
      '- [x] 负数的负号在货币符号之前',
      '',
      '### 补充',
      '',
      '1. 新增的单元测试覆盖以上行为',
      '',
      '## Out of scope',
      '',
      '- 本地化',
    ].join('\n');
    expect(extractAcceptanceCriteria(body)).toEqual([
      "`formatMoney(1234, 'JPY')` 为 `¥1,234`",
      '负数的负号在货币符号之前',
      '新增的单元测试覆盖以上行为',
    ]);
  });

  it('中文标题"验收标准"与加粗段落标题；加粗段落的一节到下一个加粗段落为止', () => {
    expect(extractAcceptanceCriteria('# 验收标准\n\n* 第一条\n* 第二条\n')).toEqual([
      '第一条',
      '第二条',
    ]);
    const bold = '**Acceptance criteria**\n\n* AC1 — 构建通过\n* AC2 — 测试通过\n\n**Out of scope:** 其他\n\n* 不算';
    expect(extractAcceptanceCriteria(bold)).toEqual(['AC1 — 构建通过', 'AC2 — 测试通过']);
  });

  it('嵌套列表留在所属的条目中；没有这一节时为空', () => {
    expect(
      extractAcceptanceCriteria('## Acceptance Criteria\n\n- 外层\n  - 内层 a\n  - 内层 b\n- 第二条\n'),
    ).toEqual(['外层\n\n* 内层 a\n* 内层 b', '第二条']);
    expect(extractAcceptanceCriteria('## Testing & acceptance: definition of done\n\n1. 测试通过')).toEqual(
      [],
    );
    expect(extractAcceptanceCriteria('')).toEqual([]);
  });
});
