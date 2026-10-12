import { z } from 'zod';
import { models, parseStructured, type StructuredRequest } from '../llm/client.js';
import { isFiller } from '../llm/filler.js';
import type { TokenUsage } from '../llm/pricing.js';
import type { ArtifactRubric, Task } from '../tasks/schema.js';
import type { EvalSpec, RubricArtifactSpec } from '../workflows/schema.js';
import { chineseCount } from '../workflows/text.js';
import type { GradeItem } from './schema.js';

// judge 看到的评测配置：入口命令（workflow id）与 rubric 积木列出的产物（Contracts 16.2）
export interface JudgeStage {
  stage: Pick<EvalSpec, 'id'>;
  artifacts: RubricArtifactSpec[];
}

function systemPrompt({ stage, artifacts }: JudgeStage) {
  return `你是一个 AI 编码 workflow 评估系统的评分员。被评估的是 Magi workflow 的 /${stage.id} 流程：agent 拿到用户的一句想法，与用户对话后依次产出 ${artifacts.map((a) => a.id).join('、')} ${chineseCount(artifacts.length)}个产物。你每次只评一个产物。

评分规则：
- 严格按 rubric 逐条评分：每一条都要评，只评列出的条目，条目之间互不影响，不给整体印象分。
- 只依据产物文本中实际写出的内容判定。task 的想法与隐藏需求只用于理解条目在问什么；产物没有写出的内容一律视为没有，不替 agent 推测意图，不因写得长或格式好加分。
- score 为 0 到该条 maxScore 之间的整数：完全满足给满分，完全没有给 0，部分满足按满足的程度给中间分。
- reasoning 用中文写一到三句：指出产物中支持该分数的具体内容（可以短引原文），或指出缺少的内容。
- 按条目编号作答：respond 的参数中 item_1 是条目 1 的评分，item_2 是条目 2 的评分，依此类推，每个条目都有 reasoning 与 score。`;
}

// 按编号作答（与模拟用户相同，见 Reports/W21、W23）：gateway 不执行 strict tool 的约束，
// 需要模型抄写的字段会出错，itemId 由代码按编号对应回 rubric
export const itemKey = (index: number) => `item_${String(index + 1)}`;

function userPrompt(task: Task, judging: JudgeStage, group: ArtifactRubric, content: string) {
  const spec = judging.artifacts.find((a) => a.id === group.artifact);
  if (spec === undefined) {
    throw new Error(`大阶段 ${judging.stage.id} 的 rubric 积木没有产物 ${group.artifact}`);
  }
  const items = group.items
    .map((i, n) => `- 条目 ${String(n + 1)}（maxScore ${String(i.maxScore)}）：${i.criterion}`)
    .join('\n');
  const input =
    task.input === undefined ? '' : `用户交给 /${judging.stage.id} 的原话：\n${task.input}\n\n`;
  return `task：${task.title}

${input}隐藏需求（模拟用户只在被问到时透露）：
${task.hiddenRequirements}

被评分的产物：${spec.description}

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

const JudgedItem = z.object({ reasoning: z.string().min(1), score: z.int() });

export function judgeSchema(group: ArtifactRubric) {
  return z.object(Object.fromEntries(group.items.map((_, i) => [itemKey(i), JudgedItem])));
}

type Judgment = Record<string, z.infer<typeof JudgedItem>>;

// reasoning 是一到三句完整的话，以句末标点结束（其后可以是引号、括号）。sonnet 有时只写出半句
// （"每张工单只有一句话的"），其余条目填占位内容（Reports/W23）
const SENTENCE_END = /[。！？.!?…][」』"”'’）)】\]]*\s*$/u;

// judge 的请求：judgeArtifact 与 .work/w23 的统计脚本共用
export function judgeRequest(
  task: Task,
  judging: JudgeStage,
  group: ArtifactRubric,
  content: string,
  model: string,
): StructuredRequest<Judgment> {
  return {
    model,
    system: systemPrompt(judging),
    user: userPrompt(task, judging, group, content),
    schema: judgeSchema(group),
    maxTokens: 8000,
  };
}

// reasoning 是占位内容或没有写完时抛错；验收标准 judge（ic-criteria.ts）共用
export function checkReasoning(itemId: string, reasoning: string) {
  if (isFiller(reasoning)) {
    throw new Error(`judge 给 ${itemId} 的 reasoning 是占位内容：${JSON.stringify(reasoning)}`);
  }
  if (!SENTENCE_END.test(reasoning)) {
    throw new Error(`judge 给 ${itemId} 的 reasoning 没有写完：${JSON.stringify(reasoning)}`);
  }
}

// 按编号把 judge 的回答对应回 rubric 条目；缺少条目、reasoning 是占位内容或没有写完、分数越界时抛错
export function readJudgment(group: ArtifactRubric, judgment: Judgment): GradeItem[] {
  return group.items.map((rubricItem, i): GradeItem => {
    const judged = judgment[itemKey(i)];
    if (judged === undefined) throw new Error(`judge 没有返回条目 ${rubricItem.id}`);
    checkReasoning(rubricItem.id, judged.reasoning);
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
}

// 一个产物一次 judge 调用
export async function judgeArtifact(
  task: Task,
  judging: JudgeStage,
  group: ArtifactRubric,
  content: string,
  signal: AbortSignal,
): Promise<JudgeResult> {
  const result = await parseStructured({
    ...judgeRequest(task, judging, group, content, models.judge),
    signal,
  });
  const items = readJudgment(group, result.value);
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
