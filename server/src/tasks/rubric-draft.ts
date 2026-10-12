import type { Db } from '../db/index.js';
import { models, parseStructured, type StructuredRequest } from '../llm/client.js';
import { HttpError } from '../variants/errors.js';
import { loadBigStage } from '../workflows/index.js';
import { type BigStageDefinition, rubricOf, type RubricArtifactSpec } from '../workflows/schema.js';
import { chineseCount } from '../workflows/text.js';
import {
  Rubric,
  type RubricDraft,
  rubricDraftOutput,
  type RubricDraftOutput,
  type RubricDraftRequest,
  taskFieldIssues,
} from './schema.js';

// 条目 id 的前缀：组 id 的首字母；首字母与其他组相同时用整个组 id
function prefixes(artifacts: RubricArtifactSpec[]): Map<string, string> {
  const first = artifacts.map((a) => a.id.slice(0, 1));
  return new Map(
    artifacts.map((a, i) => [
      a.id,
      first.filter((f) => f === first[i]).length > 1 ? a.id : (first[i] ?? a.id),
    ]),
  );
}

function systemPrompt(stage: BigStageDefinition, artifacts: RubricArtifactSpec[]) {
  const prefix = prefixes(artifacts);
  const ids = [...prefix.entries()];
  const [firstId, firstPrefix] = ids[0] ?? ['', ''];
  const examples = [
    `${firstId} 为 ${firstPrefix}1、${firstPrefix}2…`,
    ...ids.slice(1).map(([id, p]) => `${id} 为 ${p}1…`),
  ];
  return `你为一个 AI 编码 workflow 的评估系统起草评分 rubric。

被评估的是 Magi workflow 的 /${stage.id} 流程：agent 拿到用户的一句想法，依次产出${chineseCount(artifacts.length)}个产物文件。
${artifacts.map((a) => `- ${a.id}：${a.description}`).join('\n')}

评分时 judge 只能看到产物文本、task 的想法与隐藏需求。你要写的 rubric 条目必须满足：
- 每一条都能只看这一个产物就独立判定，不依赖其他条目的结论；
- 具体到这个 task：引用隐藏需求中的具体需求、边界与约束，检查产物是否把它们问出来并写清楚；不要写放之四海而皆准的空话；
- 一条只检查一件事，用"产物是否……"的句式写出可观察的判定标准；
- 每组 4 到 8 条；maxScore 为 1 到 5 的整数，越重要分值越高；
- id 用组的前缀加序号：${examples.join('，')}；
- ${chineseCount(artifacts.length)}组依次为 ${artifacts.map((a) => a.id).join('、')}，每组只出现一次。
criterion 使用中文。`;
}

function userPrompt(stage: BigStageDefinition, task: RubricDraftRequest, groups: number) {
  return `task：${task.title}
${task.input === undefined ? '' : `\n用户交给 /${stage.id} 的原话：\n${task.input}\n`}
模拟用户的 persona：
${task.persona}

隐藏需求（模拟用户只在被问到时透露；产物应当通过提问把它们弄清楚）：
${task.hiddenRequirements}

请起草${chineseCount(groups)}组 rubric。`;
}

// 起草请求：大阶段没有 rubric 评分时 400
export function rubricDraftRequest(
  stage: BigStageDefinition,
  task: RubricDraftRequest,
  model: string,
): StructuredRequest<RubricDraftOutput> {
  const artifacts = rubricOf(stage);
  const [first, ...rest] = artifacts?.map((a) => a.id) ?? [];
  if (artifacts === null || first === undefined) {
    throw new HttpError(400, `${task.workflow} 的大阶段 ${task.bigStage} 没有 rubric 评分`);
  }
  return {
    model,
    system: systemPrompt(stage, artifacts),
    user: userPrompt(stage, task, artifacts.length),
    schema: rubricDraftOutput([first, ...rest]),
    maxTokens: 8000,
  };
}

export async function draftRubric(db: Db, task: RubricDraftRequest): Promise<RubricDraft> {
  const stage = loadBigStage(db, task.workflow, task.bigStage);
  const result = await parseStructured(rubricDraftRequest(stage, task, models.judge));
  const rubric = Rubric.parse(result.value.rubric);
  const issues = taskFieldIssues({ ...task, rubric }, stage).filter((i) => i.includes('rubric'));
  if (issues.length > 0) throw new Error(`起草的 rubric 不符合大阶段：${issues.join('；')}`);
  return {
    rubric,
    model: result.model,
    costUsd: result.costUsd,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  };
}
