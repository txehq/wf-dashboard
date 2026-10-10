import { z } from 'zod';
import { models, parseStructured } from '../llm/client.js';
import type { TokenUsage } from '../llm/pricing.js';
import type { ArtifactRubric, LfgTask, RubricArtifact } from '../tasks/schema.js';
import type { GradeItem } from './schema.js';

const artifactNames: Record<RubricArtifact, string> = {
  brief: 'Brief.md：interview 阶段写出的需求简报',
  research: 'Research.md：基于 brief 的调研与 spec',
  plan: '锁定后的 plan（Research.md 的 Plan 一节或 System Design.md）',
  tickets: 'Tickets.md 与该 run 在 Linear 中建出的工单',
};

const system = `你是一个 AI 编码 workflow 评估系统的评分员。被评估的是 Magi workflow 的 /lfg 流程：agent 拿到用户的一句想法，与用户对话后依次产出 brief、research、plan、tickets 四个产物。你每次只评一个产物。

评分规则：
- 严格按 rubric 逐条评分：每一条都要评，只评列出的条目，条目之间互不影响，不给整体印象分。
- 只依据产物文本中实际写出的内容判定。task 的想法与隐藏需求只用于理解条目在问什么；产物没有写出的内容一律视为没有，不替 agent 推测意图，不因写得长或格式好加分。
- score 为 0 到该条 maxScore 之间的整数：完全满足给满分，完全没有给 0，部分满足按满足的程度给中间分。
- reasoning 用中文写一到三句：指出产物中支持该分数的具体内容（可以短引原文），或指出缺少的内容。
- 输出的 items 与 rubric 条目一一对应，itemId 原样使用。`;

function userPrompt(task: LfgTask, group: ArtifactRubric, content: string) {
  const items = group.items
    .map((i) => `- itemId: ${i.id}（maxScore ${String(i.maxScore)}）：${i.criterion}`)
    .join('\n');
  return `task：${task.title}

用户交给 /lfg 的原话：
${task.input}

隐藏需求（模拟用户只在被问到时透露）：
${task.hiddenRequirements}

被评分的产物：${artifactNames[group.artifact]}

rubric（${String(group.items.length)} 条）：
${items}

产物全文如下，位于 <artifact> 标签之间：
<artifact>
${content}
</artifact>`;
}

export interface JudgeResult {
  items: GradeItem[];
  model: string;
  usage: TokenUsage;
  costUsd: number;
}

// 一个产物一次 judge 调用；条目集合与 rubric 不一致、分数越界时抛错
export async function judgeArtifact(
  task: LfgTask,
  group: ArtifactRubric,
  content: string,
  signal: AbortSignal,
): Promise<JudgeResult> {
  const ids = group.items.map((i) => i.id);
  const schema = z.object({
    items: z.array(z.object({ itemId: z.enum(ids), reasoning: z.string().min(1), score: z.int() })),
  });
  const result = await parseStructured({
    model: models.judge,
    system,
    user: userPrompt(task, group, content),
    schema,
    maxTokens: 8000,
    signal,
  });
  const byId = new Map(result.value.items.map((i) => [i.itemId, i]));
  const returned = result.value.items.map((i) => i.itemId);
  if (byId.size !== returned.length || returned.length !== ids.length) {
    throw new Error(
      `judge 返回的 ${group.artifact} 条目与 rubric 不一致：返回 ${returned.join(',')}，rubric 为 ${ids.join(',')}`,
    );
  }
  const items = group.items.map((rubricItem): GradeItem => {
    const judged = byId.get(rubricItem.id);
    if (judged === undefined) throw new Error(`judge 没有返回条目 ${rubricItem.id}`);
    if (judged.score < 0 || judged.score > rubricItem.maxScore) {
      throw new Error(
        `judge 给 ${rubricItem.id} 的分数 ${String(judged.score)} 超出 0..${String(rubricItem.maxScore)}`,
      );
    }
    return {
      itemId: rubricItem.id,
      criterion: rubricItem.criterion,
      score: judged.score,
      maxScore: rubricItem.maxScore,
      reasoning: judged.reasoning,
    };
  });
  return { items, model: result.model, usage: result.usage, costUsd: result.costUsd };
}

// 产物不存在：每条记 0 分，不调用 judge
export function missingArtifactItems(group: ArtifactRubric): GradeItem[] {
  return group.items.map((i) => ({
    itemId: i.id,
    criterion: i.criterion,
    score: 0,
    maxScore: i.maxScore,
    reasoning: `产物 ${group.artifact} 不存在，该条记 0 分。`,
  }));
}
