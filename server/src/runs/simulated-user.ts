import { z } from 'zod';
import type { AskQuestion } from '../db/schema.js';
import { EVAL_PROJECT, EVAL_TEAM } from '../external/linear.js';
import { ORG } from '../external/github.js';
import { models, parseStructured } from '../llm/client.js';
import { isFiller } from '../llm/filler.js';
import { type EvalSpec, hasRepo } from '../workflows/schema.js';

// Fixed answer to the dispatch gate (Spikes/Stage Markers 1.5)
export const DISPATCH_GATE_REPLY = 'Do not dispatch. Stop here.';
const GO = /\bgo\b/i;

// Eval config the simulated user sees: entry command (workflow id), building blocks (facts of the eval environment), done condition and dispatch gate (Contracts 16.2)
export type PersonaStage = Pick<EvalSpec, 'id' | 'prepare' | 'done' | 'dispatchGate'>;

// The person the simulated user plays: runs and interactions with a task take the task's fields
export interface SimulatedPersona {
  // Eval config of the conversation's workflow; null for resumed sessions and workflows without an eval kind
  stage: PersonaStage | null;
  persona: string;
  // Requirements revealed only when asked; no section when empty
  hiddenRequirements: string;
}

// Shared facts of the eval environment (runs and isolated interactions)
export interface EvalFacts {
  // Run id or interaction id, also the feature slug
  runId: string;
  // txehq/wfe-<id>; null when the eval kind has no repo building block
  repo: string | null;
  // Identifier of the ticket copy
  ticket: string | null;
  product: string;
}

// Goal handed to the simulated user for a Live item without a task (Contracts 34.2): only what to do, no persona
export interface SimulatedGoal {
  goal: string;
  // The item's original user request (initial message without the slash command, or the first user message of an existing session)
  request: string;
  // Eval config of the conversation's workflow; null without an eval kind and for items started from an existing session
  stage: PersonaStage | null;
}

export const isGoal = (role: SimulatedPersona | SimulatedGoal): role is SimulatedGoal =>
  'goal' in role;

export interface SimulatedUserContext {
  // The person to play (runs and interactions with a task), or the goal to reach (Contracts 34.2)
  task: SimulatedPersona | SimulatedGoal;
  // null for real-environment interactions: the agent works on the user's real directories, repos and tickets
  eval: EvalFacts | null;
  // Cancels generation when a human takes over driving an interaction
  signal?: AbortSignal | undefined;
}

// One transcript entry: what the agent said, or what the played user (simulated user or human) sent
export interface TranscriptEntry {
  speaker: 'agent' | 'user';
  content: string;
}

export type AgentPrompt =
  { kind: 'text'; text: string } | { kind: 'questions'; questions: AskQuestion[] };

export interface SimulatedReply {
  reply: string;
  // Given when answering AskUserQuestion: key is the question text, value the option label
  answers?: Record<string, string>;
  // The same answer as option numbers and "other" text in question order; interactions turn it into terminal keys
  selections?: QuestionAnswer[];
  done: boolean;
  // Goal mode (Contracts 34.2): the reason for the judgement, shown to the user when done
  reason?: string;
  costUsd: number;
  model: string;
}

// Answers to text prompts have no answers field; answers to AskUserQuestion must give answers.
// Structured output does not support objects with arbitrary keys: answers gets fixed keys question_1, question_2... per question, then becomes a Record keyed by question text
// (the /ic Goal confirmation question runs to hundreds of characters; the model copies it wrong or leaves it empty).
// Options are numbered too: on the gateway, free-text fields of strict tools get filled with placeholders, empty strings or garbage (both opus and sonnet),
// and fields that copy a label fail most often, see Reports/W21.
// When the eval kind has a dispatch gate, answeringDispatchGate comes before done: the model first decides whether this turn answers the gate,
// then decides done (sonnet deciding done in one step gives true on the gate turn, see Reports/W40)
const GateField = z.object({ answeringDispatchGate: z.boolean() });
const QuestionAnswer = z.object({
  optionNumbers: z.array(z.number().int()),
  otherAnswer: z.string(),
});
type QuestionAnswer = z.infer<typeof QuestionAnswer>;

const questionKey = (index: number) => `question_${String(index + 1)}`;

// With a dispatch gate, answeringDispatchGate goes first; goal mode (Contracts 34.2) adds a reason for done at the end
type WithGate<T> = T & { answeringDispatchGate?: boolean; reason?: string };

const ReasonField = z.object({ reason: z.string().min(1) });

const TextAnswer = z.object({ reply: z.string().min(1), done: z.boolean() });
export const textOutput = (
  gate: boolean,
  goal = false,
): z.ZodType<WithGate<z.infer<typeof TextAnswer>>> => {
  const base = gate ? GateField.extend(TextAnswer.shape) : TextAnswer;
  return goal ? base.extend(ReasonField.shape) : base;
};

export function questionOutput(questions: AskQuestion[], gate: boolean, goal = false) {
  const fields = z.object({
    reply: z.string().min(1),
    answers: z.object(
      Object.fromEntries(questions.map((_, i) => [questionKey(i), QuestionAnswer])),
    ),
    done: z.boolean(),
  });
  const base = gate ? GateField.extend(fields.shape) : fields;
  const schema: z.ZodType<WithGate<z.infer<typeof fields>>> = goal
    ? base.extend(ReasonField.shape)
    : base;
  return schema;
}

// Throws when reply or any answer is filler, which fails the run
export function rejectFiller(reply: string, answers: Record<string, string> = {}) {
  const fields: [string, string][] = [
    ['reply', reply],
    ...Object.entries(answers).map(([q, a]): [string, string] => [`answer to "${q}"`, a]),
  ];
  for (const [field, text] of fields) {
    if (isFiller(text)) {
      throw new Error(`Simulated user's ${field} is filler: ${JSON.stringify(text)}`);
    }
  }
}

// Built from the building blocks (Contracts 16.2): the repo block gives this run's repo, vault-dir gives product and feature slug, ticket-copy gives the ticket
function facts(stage: PersonaStage | null, ctx: EvalFacts): string[] {
  const prepare = stage?.prepare ?? [];
  return [
    `- Ticket system: Linear team ${EVAL_TEAM}, project "${EVAL_PROJECT}".`,
    stage !== null && hasRepo(stage) && ctx.repo !== null
      ? `- Code hosting: GitHub organization ${ORG}; this run's repo is ${ctx.repo}.`
      : `- Code hosting: GitHub organization ${ORG}.`,
    ...(prepare.includes('vault-dir')
      ? [
          `- Documents go into the Obsidian vault; the product is "${ctx.product}" and the feature slug is ${ctx.runId}.`,
        ]
      : []),
    ...(prepare.includes('ticket-copy')
      ? [`- The ticket to work on is ${ctx.ticket ?? '(not created)'}.`]
      : []),
  ];
}

const SENTENCE_END = /[.!?]$/u;
const sentence = (text: string) => `${text}${SENTENCE_END.test(text) ? '' : '.'}`;

// When the agent stops to wait for an external condition (quota reset, a service coming back, someone else acting) without asking the user, the conversation will not move on
const WAITING_RULE =
  'The agent did not ask you anything in its latest turn and instead says it is waiting for some external condition before it can continue (for example a quota reset, a service coming back, or someone else finishing an action) → treat the agent as unable to continue; done is true.';

// Contracts 7.4: check the rules in order and stop at the first match. With a dispatch gate the first rule is "this turn answers the gate → done is false"
function doneRule(stage: PersonaStage | null): string[] {
  const reached =
    stage === null
      ? 'The agent reports in its latest turn that all the work you gave it is finished, or the agent explicitly reports that it cannot continue.'
      : sentence(stage.done.trim());
  const steps = [
    ...(stage?.dispatchGate === true
      ? [
          'answeringDispatchGate is true (you are answering the dispatch gate in this turn) → done must be false. Your answer is sent to the agent, which reports its final state only after receiving it; only a later turn can end the conversation.',
        ]
      : []),
    `This condition holds → done is true: ${reached}`,
    WAITING_RULE,
    'None of the above holds → done is false.',
  ];
  return [
    ...(stage === null ? [] : [`This is a /${stage.id} run.`]),
    'Check the rules in order and stop at the first one that matches; do not look at the rest:',
    ...steps.map((s, i) => `${String(i + 1)}. ${s}`),
  ];
}

// Goal mode (Contracts 34.2): on behalf of the person who set the goal, push the agent to reach it; each time the agent stops, decide the next message or judge it done
function goalSystemPrompt(ctx: SimulatedUserContext, role: SimulatedGoal): string {
  const lines = [
    'On behalf of the person who set the goal below, you talk with a coding agent and push it to reach the goal.',
    '',
    '## What to do this time',
    role.goal.trim(),
    '',
    '## Rules',
    '- Each time the agent stops, look at the goal, the original request and the conversation so far, and write the next message to send it: answer its question, or tell it what to do next.',
    '- Answer only from the goal and the original request; decide details the goal does not cover by common sense, and do not add new requirements.',
    '- Do not ask the agent to skip, merge or simplify any step of the workflow; when it asks you to confirm, choose or review, answer from the standpoint of the goal.',
    '- You cannot open links, run commands, operate any external system or do research for the agent; when it asks you to do such things, say truthfully that you cannot.',
  ];
  if (ctx.eval === null) {
    lines.push(
      "- Authorization: the agent works on the user's real directories, repos and tickets. When asked for authorization, authorize only the operations needed to reach this goal.",
    );
  } else {
    lines.push(
      '- Authorization: the agent may create tickets in the Linear project above, create repos and PRs in the GitHub organization txehq, and write to Project Magi Eval/ in the vault. When asked whether these operations are authorized, say yes; do not authorize anything beyond them.',
      '',
      '## Shared facts of the eval environment (answer truthfully when the agent asks)',
      ...facts(role.stage, ctx.eval),
    );
  }
  if (role.stage?.dispatchGate === true) {
    lines.push(
      '',
      '## dispatch gate',
      `When the agent has created the tickets, shown the execution plan and asks whether to dispatch (for example by replying go or go wave N to dispatch the implementation), the answer is always "${DISPATCH_GATE_REPLY}". Your answer must never contain the word go, not even in a phrase such as "go ahead". When the agent asks with options, choose the option that means not dispatching.`,
      'answeringDispatchGate: true when the agent asks you exactly this, whether to dispatch, in its latest turn; false in every other turn. Decide it first, then decide done.',
    );
  }
  lines.push(
    '',
    '## When to finish (done)',
    'Check the rules in order and stop at the first one that matches; do not look at the rest:',
    ...(role.stage?.dispatchGate === true
      ? [
          '1. answeringDispatchGate is true (you are answering the dispatch gate in this turn) → done must be false.',
          '2. The goal is reached (the agent reports it is finished and what it built matches the goal) → done is true.',
          `3. ${WAITING_RULE}`,
          '4. The agent explicitly reports that it cannot continue → done is true.',
          '5. None of the above holds → done is false.',
        ]
      : [
          '1. The goal is reached (the agent reports it is finished and what it built matches the goal) → done is true.',
          `2. ${WAITING_RULE}`,
          '3. The agent explicitly reports that it cannot continue → done is true.',
          '4. None of the above holds → done is false.',
        ]),
    'reason: one sentence giving the reason for this judgement; it is shown to the user when done is true.',
    'When done is true, reply is a short closing sentence; it is not sent to the agent.',
    '',
    '## Output',
    "- Write in English. When the text needs quotation marks, use single quotes ('...'); never use double quotes.",
    '- When the agent asks or reports in text (even if the text lists options such as A/B): reply is what you send to the agent; state your choice in reply.',
    '',
    '## AskUserQuestion answer format',
    "When the agent asks with options, answers has one key per question: 'Question 1' is question_1, 'Question 2' is question_2, and so on.",
    "- optionNumbers holds the numbers of the chosen options ('Option 1' is 1). Give one number for a single-choice question; give all chosen numbers for a multiple-choice question. When you chose options, otherAnswer is an empty string.",
    '- When no option fits, optionNumbers is an empty array and otherAnswer holds your own short answer.',
    '- reply: one sentence explaining your choice.',
  );
  return lines.join('\n');
}

export function systemPrompt(ctx: SimulatedUserContext): string {
  const { task } = ctx;
  if (isGoal(task)) return goalSystemPrompt(ctx, task);
  const lines = [
    ctx.eval === null
      ? 'You play the user in a real use of a Magi workflow, talking with a coding agent (Claude Code).'
      : 'You play the user in an eval run of a Magi workflow, talking with a coding agent (Claude Code).',
    '',
    '## The person you play',
    task.persona.trim(),
  ];
  if (task.hiddenRequirements.trim() !== '') {
    lines.push(
      '',
      '## The full requirements in your head (reveal only when asked)',
      task.hiddenRequirements.trim(),
    );
  }
  lines.push(
    '',
    '## Rules',
    '- Answer only what the agent asks. Reveal only the part of the requirements it asks about; do not pour out all requirements at once, and do not volunteer details nobody asked for.',
    "- Always keep this person's identity, level of knowledge and way of speaking.",
    "- Do not ask the agent to skip, merge or simplify any step of the workflow; when the agent asks you to confirm, choose or review, answer from this person's standpoint.",
    '- You cannot open links, run commands, operate any external system or do research for the agent; when the agent asks you to do such things, say truthfully that you cannot.',
  );
  if (ctx.eval === null) {
    lines.push(
      "- Authorization: the agent works on the user's real directories, repos and tickets. When asked for authorization, authorize only the operations needed to finish the work you gave it.",
    );
  } else {
    lines.push(
      '- Authorization: the agent may create tickets in the Linear project above, create repos and PRs in the GitHub organization txehq, and write to Project Magi Eval/ in the vault. When asked whether these operations are authorized, say yes; do not authorize anything beyond them.',
      '',
      '## Shared facts of the eval environment (answer truthfully when the agent asks)',
      ...facts(task.stage, ctx.eval),
    );
  }
  if (task.stage?.dispatchGate === true) {
    lines.push(
      '',
      '## dispatch gate',
      `When the agent has created the tickets, shown the execution plan and asks whether to dispatch (for example by replying go or go wave N to dispatch the implementation), the answer is always "${DISPATCH_GATE_REPLY}". Your answer must never contain the word go, not even in a phrase such as "go ahead". When the agent asks with options, choose the option that means not dispatching.`,
      'answeringDispatchGate: true when the agent asks you exactly this, whether to dispatch, in its latest turn, so that your answer in this turn is the answer to the dispatch gate; false in every other turn (including the turn after you answered the gate, in which the agent reports its final state). Decide it first, then decide done.',
    );
  }
  lines.push(
    '',
    '## When to finish (done)',
    ...doneRule(task.stage),
    'When done is true, reply is a short closing sentence; it is not sent to the agent.',
    '',
    '## Output',
    "- Write in English. When the text needs quotation marks, use single quotes ('...'); never use double quotes.",
    '- When the agent asks or reports in text (even if the text lists options such as A/B): reply is what you send to the agent; state your choice in reply.',
    '',
    '## AskUserQuestion answer format',
    "When the agent asks with options, answers has one key per question: 'Question 1' is question_1, 'Question 2' is question_2, and so on.",
    "- optionNumbers holds the numbers of the chosen options ('Option 1' is 1). Give one number for a single-choice question; give all chosen numbers for a multiple-choice question. When you chose options, otherAnswer is an empty string.",
    '- When no option fits, optionNumbers is an empty array and otherAnswer holds your own short answer.',
    '- reply: one sentence explaining your choice.',
  );
  return lines.join('\n');
}

function formatQuestions(questions: AskQuestion[]): string {
  return questions
    .map((q, i) =>
      [
        `Question ${String(i + 1)}${q.header ? ` (${q.header})` : ''}: ${q.question}${q.multiSelect ? ' (multiple choice)' : ''}`,
        ...q.options.map(
          (o, j) =>
            `  - Option ${String(j + 1)}: ${o.label}${o.description ? ` (description: ${o.description})` : ''}`,
        ),
      ].join('\n'),
    )
    .join('\n');
}

// Maps numbers back to the AskUserQuestion answer: the chosen options' labels (joined with ", " for multiple choice), or the own answer
function answerText(where: string, question: AskQuestion, answer: QuestionAnswer): string {
  const { optionNumbers, otherAnswer } = answer;
  if (optionNumbers.length === 0) return otherAnswer;
  if (otherAnswer !== '') {
    throw new Error(
      `${where} chose options ${JSON.stringify(optionNumbers)} and also wrote the answer ${JSON.stringify(otherAnswer)}`,
    );
  }
  if (!question.multiSelect && optionNumbers.length > 1) {
    throw new Error(
      `${where} allows one option, the simulated user chose ${JSON.stringify(optionNumbers)}`,
    );
  }
  if (new Set(optionNumbers).size !== optionNumbers.length) {
    throw new Error(`${where} has duplicate option numbers: ${JSON.stringify(optionNumbers)}`);
  }
  return optionNumbers
    .map((n) => {
      const option = question.options[n - 1];
      if (option === undefined) throw new Error(`${where} has no option ${String(n)}`);
      return option.label;
    })
    .join(', ');
}

export function userPrompt(
  transcript: TranscriptEntry[],
  prompt: AgentPrompt,
  // Goal mode (Contracts 34.2): the goal and the original user request come before the conversation
  role?: SimulatedGoal,
): string {
  const history = transcript.map(
    (e) => `[${e.speaker === 'agent' ? 'agent' : 'you'}]\n${e.content}`,
  );
  const latest =
    prompt.kind === 'text'
      ? ["## The agent's latest turn (text)", prompt.text]
      : ['## The agent asks you with options', formatQuestions(prompt.questions)];
  return [
    ...(role === undefined
      ? []
      : [
          '## What to do this time',
          role.goal,
          '',
          '## The original user request',
          role.request,
          '',
        ]),
    '## Conversation so far',
    history.length > 0 ? history.join('\n\n') : '(none)',
    '',
    ...latest,
    '',
    role === undefined
      ? 'Answer as the person you play.'
      : 'Write the next message to send to the agent, or judge that the goal is done.',
  ].join('\n');
}

// When the eval kind has a dispatch gate (Contracts 7.4): answers must not contain go; on the turn that answers the gate done must be false,
// and the answer to a text prompt must be the fixed sentence. Otherwise fails with the raw output
export function checkDispatchGate(
  stage: PersonaStage,
  prompt: AgentPrompt,
  output: {
    reply: string;
    answers?: Record<string, string>;
    done: boolean;
    answeringDispatchGate: boolean;
  },
): void {
  const said = [output.reply, ...Object.values(output.answers ?? {})];
  if (said.some((s) => GO.test(s))) {
    throw new Error(
      `In the /${stage.id} run the simulated user's answer contains go: ${JSON.stringify(said)}`,
    );
  }
  if (!output.answeringDispatchGate) return;
  if (output.done) {
    throw new Error(
      `In the /${stage.id} run the simulated user gave done: true on the turn answering the dispatch gate (it can finish only after answering the gate): ${JSON.stringify(output)}`,
    );
  }
  if (prompt.kind === 'text' && output.reply !== DISPATCH_GATE_REPLY) {
    throw new Error(
      `In the /${stage.id} run the simulated user's answer to the dispatch gate is not "${DISPATCH_GATE_REPLY}": ${JSON.stringify(output.reply)}`,
    );
  }
}

// Called when an agent turn ends (text) or on AskUserQuestion; throws when the answer breaks a constraint
export async function simulateUser(
  ctx: SimulatedUserContext,
  transcript: TranscriptEntry[],
  prompt: AgentPrompt,
): Promise<SimulatedReply> {
  const role = ctx.task;
  const goal = isGoal(role);
  const call = {
    model: models.simulatedUser,
    role: 'simulatedUser' as const,
    system: systemPrompt(ctx),
    user: userPrompt(transcript, prompt, goal ? role : undefined),
    maxTokens: 4096,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  };
  const stage = role.stage;
  const gate = stage?.dispatchGate === true;
  let reply: string;
  let done: boolean;
  let reason: string | undefined;
  let answeringDispatchGate: boolean | undefined;
  let answers: Record<string, string> | undefined;
  let selections: QuestionAnswer[] | undefined;
  let cost: { costUsd: number; model: string };
  if (prompt.kind === 'questions') {
    const result = await parseStructured({
      ...call,
      schema: questionOutput(prompt.questions, gate, goal),
    });
    ({ reply, done, reason, answeringDispatchGate } = result.value);
    cost = result;
    const given = result.value.answers;
    selections = prompt.questions.map((_, i) => {
      const answer = given[questionKey(i)];
      if (answer === undefined)
        throw new Error(`Simulated user did not answer question ${String(i + 1)}`);
      return answer;
    });
    const chosen = selections;
    answers = Object.fromEntries(
      prompt.questions.map((question, i): [string, string] => {
        const answer = chosen[i];
        if (answer === undefined)
          throw new Error(`Simulated user did not answer question ${String(i + 1)}`);
        return [question.question, answerText(`Question ${String(i + 1)}`, question, answer)];
      }),
    );
  } else {
    const result = await parseStructured({ ...call, schema: textOutput(gate, goal) });
    ({ reply, done, reason, answeringDispatchGate } = result.value);
    cost = result;
  }
  rejectFiller(reply, answers);
  if (goal) {
    if (reason === undefined || isFiller(reason)) {
      throw new Error(
        `Simulated user gave no reason for the judgement: ${JSON.stringify(reason ?? null)}`,
      );
    }
  }
  if (gate) {
    if (answeringDispatchGate === undefined)
      throw new Error('Simulated user answer lacks answeringDispatchGate');
    checkDispatchGate(stage, prompt, {
      reply,
      ...(answers === undefined ? {} : { answers }),
      done,
      answeringDispatchGate,
    });
  }
  return {
    reply,
    ...(answers === undefined ? {} : { answers }),
    ...(selections === undefined ? {} : { selections }),
    done,
    ...(reason === undefined ? {} : { reason }),
    costUsd: cost.costUsd,
    model: cost.model,
  };
}
