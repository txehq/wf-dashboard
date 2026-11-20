import { z } from 'zod';
import {
  type IcEndpoint,
  icEndpoint,
  prBranch,
  prChecks,
  prDescription,
  prDiff,
  type PrInfo,
  readPr,
} from '../external/github.js';
import { models, parseStructured, type StructuredRequest } from '../llm/client.js';
import type { TokenUsage } from '../llm/pricing.js';
import type { PrTask } from '../tasks/schema.js';
import { checkReasoning, itemKey } from './rubric-judge.js';
import type { GradeItem, IcCriteriaDetail } from './schema.js';

// 0 not met, 1 partly met, 2 met (Contracts section 13)
export const CRITERION_MAX = 2;

const system = `You are a grader in an evaluation system for AI coding workflows. Under evaluation is the /ic flow of the Magi workflow: the agent receives a ticket, implements it in a copy of the repo and opens a PR. You judge whether this PR meets each acceptance criterion of the ticket.

Grading rules:
- Grade strictly criterion by criterion: grade every criterion, grade only the listed criteria, keep the criteria independent of each other, and give no overall-impression score.
- The only evidence is the PR's diff, the PR's title and body, and the result of each CI check. A claim in the PR body counts only when the diff or a check result confirms it; any change that does not appear in the diff counts as not done, and do not guess the agent's intent.
- For a criterion that can only be confirmed by running something (for example "tests pass"), the result of the corresponding check decides; when that check did not run or has no conclusion, judge from the diff alone whether it can be met, and say so in the reasoning.
- score is only 0, 1 or 2: 0 means not met, 1 means partly met, 2 means met.
- Write reasoning in English, one to three sentences: point to the specific changes in the diff that support the score (files, functions or tests; short quotes are fine), or point out what is missing.
- Answer by criterion number: in the arguments of respond, item_1 is the grade for acceptance criterion 1, item_2 the grade for acceptance criterion 2, and so on; every item has reasoning and score.`;

interface JudgeInput {
  task: PrTask;
  pr: { number: number; url: string; title: string; body: string };
  checks: IcCriteriaDetail['checks'];
  diff: string;
}

function userPrompt({ task, pr, checks, diff }: JudgeInput) {
  const criteria = task.ticket.acceptanceCriteria
    .map((c, n) => `- Acceptance criterion ${String(n + 1)}: ${c}`)
    .join('\n');
  const required = task.requiredChecks.length === 0 ? '(none)' : task.requiredChecks.join(', ');
  const checkLines =
    checks.length === 0
      ? '(no checks on the PR head)'
      : checks.map((c) => `- ${c.name}: ${c.bucket} (${c.state})`).join('\n');
  return `Ticket title: ${task.ticket.title}

Ticket body:
${task.ticket.body}

Acceptance criteria (${String(task.ticket.acceptanceCriteria.length)}):
${criteria}

PR #${String(pr.number)}: ${pr.title}
${pr.url}

PR body:
${pr.body.trim() === '' ? '(empty)' : pr.body}

Result of each CI check (checks the endpoint requires to pass: ${required}; other checks may have no runner in the repo copy and do not count toward the endpoint):
${checkLines}

The full diff of the PR follows, between <diff> tags:
<diff>
${diff}
</diff>`;
}

const JudgedCriterion = z.object({ reasoning: z.string().min(1), score: z.int() });
type Judgment = Record<string, z.infer<typeof JudgedCriterion>>;

export function criteriaSchema(task: PrTask) {
  return z.object(
    Object.fromEntries(task.ticket.acceptanceCriteria.map((_, i) => [itemKey(i), JudgedCriterion])),
  );
}

export const criterionId = (index: number) => `ac${String(index + 1)}`;

// The diff is not truncated: when it exceeds the judge's context, the gateway's error text is the grading failure
export function criteriaRequest(input: JudgeInput, model: string): StructuredRequest<Judgment> {
  return {
    model,
    system,
    user: userPrompt(input),
    schema: criteriaSchema(input.task),
    maxTokens: 8000,
  };
}

// Map answers back to acceptance criteria by number; throw on a missing item, placeholder or unfinished reasoning, or a score other than 0 / 1 / 2
export function readCriteriaJudgment(task: PrTask, judgment: Judgment): GradeItem[] {
  return task.ticket.acceptanceCriteria.map((criterion, i): GradeItem => {
    const itemId = criterionId(i);
    const judged = judgment[itemKey(i)];
    if (judged === undefined) throw new Error(`Judge returned no acceptance criterion ${itemId}`);
    checkReasoning(itemId, judged.reasoning);
    if (judged.score < 0 || judged.score > CRITERION_MAX) {
      throw new Error(`Judge gave ${itemId} score ${String(judged.score)}, not 0, 1 or 2`);
    }
    return {
      itemId,
      criterion,
      score: judged.score,
      maxScore: CRITERION_MAX,
      reasoning: judged.reasoning,
    };
  });
}

export interface IcCriteriaResult {
  items: GradeItem[];
  reachedEnd: boolean;
  judge: { model: string; usage: TokenUsage; costUsd: number } | null;
  detail: IcCriteriaDetail;
}

// ic task without hidden tests: the judge grades the repo's latest PR per acceptance criterion; the endpoint check reads the same head;
// without a PR every criterion scores 0, the endpoint is false and no judge is called. On signal abort, throw signal.reason before the next step
export async function gradeIcCriteria(
  task: PrTask,
  repo: string,
  signal: AbortSignal,
): Promise<IcCriteriaResult> {
  const pr = await readPr(repo);
  signal.throwIfAborted();
  if (pr === null) {
    return {
      items: task.ticket.acceptanceCriteria.map((criterion, i) => ({
        itemId: criterionId(i),
        criterion,
        score: 0,
        maxScore: CRITERION_MAX,
        reasoning: 'This run created no PR, so this criterion scores 0.',
      })),
      reachedEnd: false,
      judge: null,
      detail: { pr: null, endpoint: null, checks: [], diffChars: 0 },
    };
  }
  const branch = await prBranch(repo, pr.number);
  const description = await prDescription(repo, pr.number);
  const diff = await prDiff(repo, pr.number);
  const checks = await prChecks(repo, pr.number);
  const endpoint = await icEndpoint(repo, pr.number, task.requiredChecks);
  signal.throwIfAborted();
  return judgeIcCriteria(task, { pr, branch, description, diff, checks, endpoint }, signal);
}

// PR material read for grading (Contracts section 13: diff, PR body, result of each CI check)
export interface PrMaterial {
  pr: PrInfo;
  branch: string;
  description: { title: string; body: string; headRefOid: string };
  diff: string;
  checks: IcCriteriaDetail['checks'];
  endpoint: IcEndpoint;
}

export async function judgeIcCriteria(
  task: PrTask,
  material: PrMaterial,
  signal: AbortSignal,
): Promise<IcCriteriaResult> {
  const { pr, branch, description, diff, checks, endpoint } = material;
  if (endpoint.head !== description.headRefOid) {
    throw new Error(
      `Head of ${pr.url} changed during grading: ${description.headRefOid} → ${endpoint.head}`,
    );
  }
  const result = await parseStructured({
    ...criteriaRequest(
      {
        task,
        pr: { number: pr.number, url: pr.url, title: description.title, body: description.body },
        checks,
        diff,
      },
      models.judge,
    ),
    role: 'judge',
    signal,
  });
  return {
    items: readCriteriaJudgment(task, result.value),
    reachedEnd: endpoint.reached,
    judge: { model: result.model, usage: result.usage, costUsd: result.costUsd },
    detail: {
      pr: { number: pr.number, url: pr.url, branch, head: endpoint.head },
      endpoint,
      checks,
      diffChars: diff.length,
    },
  };
}
