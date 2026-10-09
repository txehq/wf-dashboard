import { models, parseStructured } from '../llm/client.js';
import { type LfgTaskDefinition, Rubric, RubricDraftOutput, type RubricDraft } from './schema.js';

const system = `你为一个 AI 编码 workflow 的评估系统起草评分 rubric。

被评估的是 Magi workflow 的 /lfg 流程：agent 拿到用户的一句想法，依次产出四个产物文件。
- brief（Brief.md）：interview 阶段与用户对话后写出的一页需求简报，包含问题与使用者、完成标准、所在位置、明确不做的范围与约束、agent 的授权上限、留给后续阶段的开放问题、决定记录、推断出的答案及其来源。
- research（Research.md）：基于 brief 的调研，包含本地代码与历史调研、网上的先例与最佳实践、每条建议附出处、拆分成部分的 spec、带每部分测试计划与验收标准的 plan、开放决定、风险。
- plan（锁定的 plan，写在 Research.md 的 Plan 一节）：目标与不做的事、做法、按顺序排列的部分（每部分的依赖与验证方式）、决定、风险与回退、留给拆票的问题，并带锁定日期。
- tickets（Tickets.md 与 Linear 工单）：与已有工单的对照、按依赖拆分的工单（相互依赖的工作放在同一张票）、每张票的验收标准、估算与推荐负责人、依赖关系图，并停在 dispatch gate 不派发。

评分时 judge 只能看到产物文本、task 的想法与隐藏需求。你要写的 rubric 条目必须满足：
- 每一条都能只看这一个产物就独立判定，不依赖其他条目的结论；
- 具体到这个 task：引用隐藏需求中的具体需求、边界与约束，检查产物是否把它们问出来并写清楚；不要写放之四海而皆准的空话；
- 一条只检查一件事，用"产物是否……"的句式写出可观察的判定标准；
- 每组 4 到 8 条；maxScore 为 1 到 5 的整数，越重要分值越高；
- id 用组的首字母加序号：brief 为 b1、b2…，research 为 r1…，plan 为 p1…，tickets 为 t1…；
- 四组依次为 brief、research、plan、tickets，每组只出现一次。
criterion 使用中文。`;

function userPrompt(task: LfgTaskDefinition) {
  return `task：${task.title}

用户交给 /lfg 的原话：
${task.input}

模拟用户的 persona：
${task.persona}

隐藏需求（模拟用户只在被问到时透露；产物应当通过提问把它们弄清楚）：
${task.hiddenRequirements}

请起草四组 rubric。`;
}

export async function draftRubric(task: LfgTaskDefinition): Promise<RubricDraft> {
  const result = await parseStructured({
    model: models.judge,
    system,
    user: userPrompt(task),
    schema: RubricDraftOutput,
    maxTokens: 8000,
  });
  return {
    rubric: Rubric.parse(result.value.rubric),
    model: result.model,
    costUsd: result.costUsd,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  };
}
