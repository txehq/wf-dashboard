import { models, parseStructured, type StructuredRequest } from '../llm/client.js';
import { HttpError } from '../variants/errors.js';
import { evalSpec } from '../workflows/eval-kinds.js';
import { type EvalSpec, rubricOf, type RubricArtifactSpec } from '../workflows/schema.js';
import { countWord } from '../workflows/text.js';
import {
  Rubric,
  type RubricDraft,
  rubricDraftOutput,
  type RubricDraftOutput,
  type RubricDraftRequest,
  taskFieldIssues,
} from './schema.js';

// Item id prefix: the group id's first letter; the whole group id when another group shares that first letter
function prefixes(artifacts: RubricArtifactSpec[]): Map<string, string> {
  const first = artifacts.map((a) => a.id.slice(0, 1));
  return new Map(
    artifacts.map((a, i) => [
      a.id,
      first.filter((f) => f === first[i]).length > 1 ? a.id : (first[i] ?? a.id),
    ]),
  );
}

function systemPrompt(stage: EvalSpec, artifacts: RubricArtifactSpec[]) {
  const prefix = prefixes(artifacts);
  const ids = [...prefix.entries()];
  const [firstId, firstPrefix] = ids[0] ?? ['', ''];
  const examples = [
    `${firstId} uses ${firstPrefix}1, ${firstPrefix}2…`,
    ...ids.slice(1).map(([id, p]) => `${id} uses ${p}1…`),
  ];
  return `You draft grading rubrics for an evaluation system for AI coding workflows.

What is evaluated is the /${stage.id} flow of the Magi workflow: the agent receives a one-sentence idea from the user and produces ${countWord(artifacts.length)} artifact files in order.
${artifacts.map((a) => `- ${a.id}: ${a.description}`).join('\n')}

When grading, the judge sees only the artifact text, the task's idea and the hidden requirements. The rubric items you write must:
- each be decidable from this one artifact alone, independent of the conclusions of other items;
- be specific to this task: cite concrete requirements, boundaries and constraints from the hidden requirements and check whether the artifact asked about them and wrote them down clearly; no generic statements that would fit any task;
- check one thing per item, written as an observable criterion in the form "Does the artifact …?";
- number 4 to 8 per group; maxScore is an integer from 1 to 5, higher for more important items;
- use the group's prefix plus a sequence number as id: ${examples.join(', ')};
- form ${countWord(artifacts.length)} groups in the order ${artifacts.map((a) => a.id).join(', ')}, each appearing once.
Write each criterion in English.`;
}

function userPrompt(stage: EvalSpec, task: RubricDraftRequest, groups: number) {
  return `Task: ${task.title}
${task.input === undefined ? '' : `\nWhat the user said to /${stage.id}:\n${task.input}\n`}
Persona of the simulated user:
${task.persona}

Hidden requirements (the simulated user reveals them only when asked; the artifacts should make them clear by asking):
${task.hiddenRequirements}

Draft ${countWord(groups)} rubric groups.`;
}

// Drafting request: 400 when the eval kind has no rubric grading. The entry command in the prompt is the eval kind's built-in workflow (its id equals the eval kind)
export function rubricDraftRequest(
  task: RubricDraftRequest,
  model: string,
): StructuredRequest<RubricDraftOutput> {
  const stage = evalSpec(task.kind, task.kind);
  const artifacts = rubricOf(stage);
  const [first, ...rest] = artifacts?.map((a) => a.id) ?? [];
  if (artifacts === null || first === undefined) {
    throw new HttpError(400, `Eval kind ${task.kind} has no rubric grading`);
  }
  return {
    model,
    system: systemPrompt(stage, artifacts),
    user: userPrompt(stage, task, artifacts.length),
    schema: rubricDraftOutput([first, ...rest]),
    maxTokens: 8000,
  };
}

export async function draftRubric(task: RubricDraftRequest): Promise<RubricDraft> {
  const result = await parseStructured({ ...rubricDraftRequest(task, models.judge), role: 'judge' });
  const rubric = Rubric.parse(result.value.rubric);
  const issues = taskFieldIssues({ ...task, rubric }).filter((i) => i.includes('rubric'));
  if (issues.length > 0) throw new Error(`The drafted rubric does not fit the eval kind: ${issues.join('; ')}`);
  return {
    rubric,
    model: result.model,
    costUsd: result.costUsd,
    inputTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
  };
}
