import { z } from 'zod';
import { models, parseStructured, type StructuredRequest } from '../llm/client.js';
import { isFiller } from '../llm/filler.js';
import type { TokenUsage } from '../llm/pricing.js';
import type { ArtifactRubric, Task } from '../tasks/schema.js';
import type { EvalSpec, RubricArtifactSpec } from '../workflows/schema.js';
import type { GradeItem } from './schema.js';

// Eval config the judge sees: the entry command (workflow id) and the artifacts the rubric block lists (Contracts 16.2)
export interface JudgeStage {
  stage: Pick<EvalSpec, 'id'>;
  artifacts: RubricArtifactSpec[];
}

function systemPrompt({ stage, artifacts }: JudgeStage) {
  return `You are a grader in an evaluation system for AI coding workflows. Under evaluation is the /${stage.id} flow of the Magi workflow: the agent receives a one-sentence idea from the user, talks with the user, and then produces ${String(artifacts.length)} artifacts in order: ${artifacts.map((a) => a.id).join(', ')}. You grade one artifact at a time.

Grading rules:
- Grade strictly item by item against the rubric: grade every item, grade only the listed items, keep the items independent of each other, and give no overall-impression score.
- Judge only by what the artifact text actually says. The task's idea and hidden requirements only help you understand what an item asks; anything the artifact does not write down counts as absent; do not guess the agent's intent, and give no extra points for length or nice formatting.
- score is an integer from 0 to the item's maxScore: full marks when fully met, 0 when entirely absent, and a score in between according to how much is met when partly met.
- Write reasoning in English, one to three sentences: point to the specific content in the artifact that supports the score (short quotes are fine), or point out what is missing.
- Answer by item number: in the arguments of respond, item_1 is the grade for item 1, item_2 the grade for item 2, and so on; every item has reasoning and score.`;
}

// Answer by number (as the simulated user does, see Reports/W21, W23): the gateway does not enforce strict tool constraints,
// so fields the model must copy go wrong; code maps itemId back to the rubric by number
export const itemKey = (index: number) => `item_${String(index + 1)}`;

function userPrompt(task: Task, judging: JudgeStage, group: ArtifactRubric, content: string) {
  const spec = judging.artifacts.find((a) => a.id === group.artifact);
  if (spec === undefined) {
    throw new Error(
      `Rubric block of workflow ${judging.stage.id} has no artifact ${group.artifact}`,
    );
  }
  const items = group.items
    .map((i, n) => `- Item ${String(n + 1)} (maxScore ${String(i.maxScore)}): ${i.criterion}`)
    .join('\n');
  const input =
    task.input === undefined
      ? ''
      : `The user's exact words to /${judging.stage.id}:\n${task.input}\n\n`;
  return `Task: ${task.title}

${input}Hidden requirements (the simulated user reveals them only when asked):
${task.hiddenRequirements}

Artifact being graded: ${spec.description}

Rubric (${String(group.items.length)} items):
${items}

The full artifact follows, between <artifact> tags:
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

// reasoning is one to three complete sentences ending in sentence-final punctuation (optionally followed by quotes or brackets). Sonnet sometimes writes
// only half a sentence and fills the other items with placeholders (Reports/W23)
const SENTENCE_END = /[.!?…]["”'’)\]]*\s*$/u;

// The judge request: shared by judgeArtifact and the .work/w23 statistics script
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

// Throw when reasoning is a placeholder or unfinished; shared with the acceptance criteria judge (ic-criteria.ts)
export function checkReasoning(itemId: string, reasoning: string) {
  if (isFiller(reasoning)) {
    throw new Error(
      `Judge's reasoning for ${itemId} is a placeholder: ${JSON.stringify(reasoning)}`,
    );
  }
  if (!SENTENCE_END.test(reasoning)) {
    throw new Error(`Judge's reasoning for ${itemId} is unfinished: ${JSON.stringify(reasoning)}`);
  }
}

// Map the judge's answers back to rubric items by number; throw on a missing item, placeholder or unfinished reasoning, or an out-of-range score
export function readJudgment(group: ArtifactRubric, judgment: Judgment): GradeItem[] {
  return group.items.map((rubricItem, i): GradeItem => {
    const judged = judgment[itemKey(i)];
    if (judged === undefined) throw new Error(`Judge returned no item ${rubricItem.id}`);
    checkReasoning(rubricItem.id, judged.reasoning);
    if (judged.score < 0 || judged.score > rubricItem.maxScore) {
      throw new Error(
        `Judge gave ${rubricItem.id} score ${String(judged.score)}, outside 0..${String(rubricItem.maxScore)}`,
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

// One judge call per artifact
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

// Artifact missing: every item scores 0 and no judge is called
export function missingArtifactItems(group: ArtifactRubric): GradeItem[] {
  return group.items.map((i) => ({
    itemId: i.id,
    criterion: i.criterion,
    score: 0,
    maxScore: i.maxScore,
    reasoning: `Artifact ${group.artifact} does not exist, so this item scores 0.`,
  }));
}
