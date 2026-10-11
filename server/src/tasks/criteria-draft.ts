import { z } from 'zod';
import { models, parseStructured, type StructuredRequest } from '../llm/client.js';
import { isFiller } from '../llm/filler.js';

// 由 judge 读工单标题与完整正文确定验收标准（Contracts 第 13 节）；quote 是该条依据的正文原文片段

const system = `你为一个 AI 编码 workflow 的评估系统整理工单的验收标准。评估时另一个评分员会逐条对照这些标准，判断 agent 开出的 PR 是否满足工单。

规则：
- 正文中有明确的验收标准一节（标题或加粗的段落标题为"验收标准""验收条件""Acceptance criteria""Acceptance"等，下面是列表）时：这一节的每个列表项是一条，按原顺序逐条照原文取出。text 是该列表项的原文，不改写、不翻译、不合并、不拆分；去掉列表符号（"-"、"*"、"1."）与任务勾选框（"[ ]"、"[x]"），保留其余全部文字，包括 AC1 这类编号、行内代码的反引号与标点。
- 正文中没有这样一节时：从正文的问题描述、修复要求与测试要求整理出可以检查的条目。每条是一个能对照 PR 的 diff 与 CI 结果判断"满足 / 部分满足 / 未满足"的具体要求；只写正文中有依据的要求，不加正文没有的要求；条目之间不重复。text 用正文的语言书写。
- quote 是这一条依据的正文原文片段：从正文中逐字复制一段连续的文字（可以是一句话或一个列表项的一部分），必须与正文完全一致，包括大小写、标点、空格与反引号；不要跨越换行，不要省略中间的文字。
- 必须调用 respond 给出结果：criteria 按顺序排列。`;

const Output = z.object({
  criteria: z.array(z.object({ text: z.string().min(1), quote: z.string().min(1) })).min(1),
});
type Output = z.infer<typeof Output>;

export interface DraftedCriterion {
  text: string;
  quote: string;
}

export interface CriteriaDraft {
  criteria: DraftedCriterion[];
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export function criteriaDraftRequest(
  title: string,
  body: string,
  model: string,
): StructuredRequest<Output> {
  return {
    model,
    system,
    user: `工单标题：${title}\n\n工单正文全文如下，位于 <body> 标签之间：\n<body>\n${body}\n</body>`,
    schema: Output,
    maxTokens: 8000,
  };
}

// quote 不是正文的子串、text 是占位内容时以原文抛错
export function readCriteriaDraft(body: string, output: Output): DraftedCriterion[] {
  return output.criteria.map((c, i) => {
    const n = String(i + 1);
    if (isFiller(c.text)) {
      throw new Error(`judge 给第 ${n} 条验收标准的 text 是占位内容：${JSON.stringify(c.text)}`);
    }
    if (!body.includes(c.quote)) {
      throw new Error(`judge 给第 ${n} 条验收标准的 quote 不是正文的原文：${JSON.stringify(c.quote)}`);
    }
    return { text: c.text, quote: c.quote };
  });
}

// 正文为空时没有可以依据的原文，不调用 judge，由用户在表单中填写
export async function draftCriteria(title: string, body: string): Promise<CriteriaDraft> {
  if (body.trim() === '') {
    return { criteria: [], model: models.judge, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }
  const result = await parseStructured(criteriaDraftRequest(title, body, models.judge));
  return {
    criteria: readCriteriaDraft(body, result.value),
    model: result.model,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    costUsd: result.costUsd,
  };
}
