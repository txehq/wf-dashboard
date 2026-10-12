import { z } from 'zod';
import type { AskQuestion } from '../db/schema.js';
import { EVAL_PROJECT, EVAL_TEAM } from '../external/linear.js';
import { ORG } from '../external/github.js';
import { models, parseStructured } from '../llm/client.js';
import { isFiller } from '../llm/filler.js';
import { type EvalSpec, hasRepo } from '../workflows/schema.js';

// dispatch gate 的固定回答（Spikes/Stage Markers 1.5）
export const DISPATCH_GATE_REPLY = '不派发，到此结束。';
const GO = /\bgo\b/i;

// 模拟用户看到的评测配置：入口命令（workflow id）、积木（评估环境的事实）、结束条件与 dispatch gate（Contracts 16.2）
export type PersonaStage = Pick<EvalSpec, 'id' | 'prepare' | 'done' | 'dispatchGate'>;

// 模拟用户扮演的人：run 与选了 task 的交互取 task 的字段
export interface SimulatedPersona {
  // 对话所在 workflow 的评测配置；resume 的 session 与没有评测类型的 workflow 为空
  stage: PersonaStage | null;
  persona: string;
  // 只在被问到时透露的需求；为空字符串时没有这一节
  hiddenRequirements: string;
}

// 评估环境（run 与 isolated 交互）的公共事实
export interface EvalFacts {
  // run id 或交互 id，也是 feature slug
  runId: string;
  // txehq/wfe-<id>；评测类型没有仓库积木时为空
  repo: string | null;
  // 工单副本的 identifier
  ticket: string | null;
  product: string;
}

export interface SimulatedUserContext {
  task: SimulatedPersona;
  // real 环境的交互为空：agent 在用户真实的目录、仓库与工单上工作
  eval: EvalFacts | null;
  // 交互中驾驶者变为人时取消生成
  signal?: AbortSignal | undefined;
}

// 对话记录中的一条：agent 的话，或扮演的用户（模拟用户与人）发出的话
export interface TranscriptEntry {
  speaker: 'agent' | 'user';
  content: string;
}

export type AgentPrompt =
  { kind: 'text'; text: string } | { kind: 'questions'; questions: AskQuestion[] };

export interface SimulatedReply {
  reply: string;
  // 回答 AskUserQuestion 时给出：键为问题原文，值为选项 label
  answers?: Record<string, string>;
  // 同一回答按问题顺序的选项编号与"其他"的文字；交互中换成终端按键
  selections?: QuestionAnswer[];
  done: boolean;
  costUsd: number;
  model: string;
}

// 文字提问的回答没有 answers 字段；AskUserQuestion 的回答必须给出 answers。
// 结构化输出不支持任意键的对象：answers 按提问生成固定的键 question_1、question_2…，再转成以问题原文为键的 Record
// （/ic 的 Goal 确认问题长达数百字，模型逐字抄写会抄错或留空）。
// 选项也用编号：gateway 上 strict tool 的自由文本字段会被填成 placeholder、空串或乱码（opus 与 sonnet 都会），
// 要抄写 label 的字段最常出错，见 Reports/W21。
// 有 dispatch gate 的大阶段多一个 answeringDispatchGate，排在 done 之前：模型先判断这一轮是否在回答 gate，
// 再判断 done（sonnet 一步判断 done 时在 gate 这一轮给出 true，见 Reports/W40）
const GateField = z.object({ answeringDispatchGate: z.boolean() });
const QuestionAnswer = z.object({
  optionNumbers: z.array(z.number().int()),
  otherAnswer: z.string(),
});
type QuestionAnswer = z.infer<typeof QuestionAnswer>;

const questionKey = (index: number) => `question_${String(index + 1)}`;

// 有 dispatch gate 时在最前面加 answeringDispatchGate；没有时不出现这个字段
type WithGate<T> = T & { answeringDispatchGate?: boolean };

const TextAnswer = z.object({ reply: z.string().min(1), done: z.boolean() });
export const textOutput = (gate: boolean): z.ZodType<WithGate<z.infer<typeof TextAnswer>>> =>
  gate ? GateField.extend(TextAnswer.shape) : TextAnswer;

export function questionOutput(questions: AskQuestion[], gate: boolean) {
  const fields = z.object({
    reply: z.string().min(1),
    answers: z.object(
      Object.fromEntries(questions.map((_, i) => [questionKey(i), QuestionAnswer])),
    ),
    done: z.boolean(),
  });
  const schema: z.ZodType<WithGate<z.infer<typeof fields>>> = gate
    ? GateField.extend(fields.shape)
    : fields;
  return schema;
}

// reply 或任一回答是占位内容时抛错，run 因此失败
export function rejectFiller(reply: string, answers: Record<string, string> = {}) {
  const fields: [string, string][] = [
    ['reply', reply],
    ...Object.entries(answers).map(([q, a]): [string, string] => [`对「${q}」的回答`, a]),
  ];
  for (const [field, text] of fields) {
    if (isFiller(text)) {
      throw new Error(`模拟用户的 ${field} 是占位内容：${JSON.stringify(text)}`);
    }
  }
}

// 按积木生成（Contracts 16.2）：仓库积木给出本次运行的仓库，vault-dir 给出 product 与 feature slug，ticket-copy 给出工单
function facts(stage: PersonaStage | null, ctx: EvalFacts): string[] {
  const prepare = stage?.prepare ?? [];
  return [
    `- 工单系统：Linear 的 ${EVAL_TEAM} team，"${EVAL_PROJECT}" project。`,
    stage !== null && hasRepo(stage) && ctx.repo !== null
      ? `- 代码托管：GitHub 组织 ${ORG}；本次运行的仓库是 ${ctx.repo}。`
      : `- 代码托管：GitHub 组织 ${ORG}。`,
    ...(prepare.includes('vault-dir')
      ? [`- 文档写进 Obsidian vault，product 是 "${ctx.product}"，feature slug 是 ${ctx.runId}。`]
      : []),
    ...(prepare.includes('ticket-copy') ? [`- 要做的工单是 ${ctx.ticket ?? '（未建）'}。`] : []),
  ];
}

const SENTENCE_END = /[。！？.!?]$/u;
const sentence = (text: string) => `${text}${SENTENCE_END.test(text) ? '' : '。'}`;

// agent 停下来等一个外部条件（额度恢复、服务可用、别人操作）而不是向用户提问时，对话不会再推进
const WAITING_RULE =
  'agent 最新一轮没有向你提问，而是说明它在等待某个外部条件（例如额度恢复、某个服务恢复、别人完成某个操作）才能继续 → 视为 agent 无法继续，done 为 true。';

// Contracts 7.4：按顺序逐条核对，命中一条就停。有 dispatch gate 时第一条是"这一轮在回答 gate → done 为 false"
function doneRule(stage: PersonaStage | null): string[] {
  const reached =
    stage === null
      ? 'agent 最新一轮报告你交给它的工作已经全部完成；或 agent 明确报告无法继续。'
      : sentence(stage.done.trim());
  const steps = [
    ...(stage?.dispatchGate === true
      ? [
          'answeringDispatchGate 为 true（你这一轮正在回答 dispatch gate）→ done 必须为 false。你的回答要发给 agent，agent 收到后才会报告结束状态，那之后的一轮才可能结束。',
        ]
      : []),
    `满足这一条 → done 为 true：${reached}`,
    WAITING_RULE,
    '以上都不满足 → done 为 false。',
  ];
  return [
    ...(stage === null ? [] : [`这是 /${stage.id} 运行。`]),
    '按顺序逐条核对，命中一条就停，不再看后面的：',
    ...steps.map((s, i) => `${String(i + 1)}. ${s}`),
  ];
}

export function systemPrompt(ctx: SimulatedUserContext): string {
  const { task } = ctx;
  const lines = [
    ctx.eval === null
      ? '你在一次 Magi workflow 的真实使用中扮演用户，与一个编程 agent（Claude Code）对话。'
      : '你在一次 Magi workflow 的评估运行中扮演用户，与一个编程 agent（Claude Code）对话。',
    '',
    '## 你扮演的人',
    task.persona.trim(),
  ];
  if (task.hiddenRequirements.trim() !== '') {
    lines.push('', '## 你心里的完整需求（只在被问到时透露）', task.hiddenRequirements.trim());
  }
  lines.push(
    '',
    '## 规则',
    '- 只回答 agent 问到的内容。被问到哪一部分就透露哪一部分需求，不要一次把全部需求倒出来，也不要主动补充没被问到的细节。',
    '- 始终保持这个人的身份、知识水平和说话方式。',
    '- 不要求 agent 跳过、合并或简化 workflow 的任何步骤；agent 请你确认、选择或审阅时，按这个人的立场作答。',
    '- 你不能打开链接、运行命令、操作任何外部系统，也不能替 agent 做调研；agent 请你做这些事时，如实说明你做不到。',
  );
  if (ctx.eval === null) {
    lines.push(
      '- 授权范围：agent 在用户真实的目录、仓库与工单上工作。被问到是否授权时，只授权完成你交给它的工作所必需的操作。',
    );
  } else {
    lines.push(
      '- 授权范围：agent 可以在上述 Linear project 中建工单，在 GitHub 组织 txehq 中建仓库与 PR，写 vault 的 Project Magi Eval/。被问到是否授权这些操作时回答可以；超出范围的操作不授权。',
      '',
      '## 评估环境的公共事实（agent 问到时如实回答）',
      ...facts(task.stage, ctx.eval),
    );
  }
  if (task.stage?.dispatchGate === true) {
    lines.push(
      '',
      '## dispatch gate',
      `agent 建完工单、展示执行计划并问是否派发（例如回复 go 或 go wave N 派发实现）时，回答固定为"${DISPATCH_GATE_REPLY}"。回答中绝不能出现 go 这个词。agent 用选项提问时，选择表示不派发的那个选项。`,
      'answeringDispatchGate：agent 最新一轮正是这样问你是否派发时为 true，你这一轮的回答就是对 dispatch gate 的回答；其他任何一轮（包括你回答 gate 之后 agent 报告结束状态的那一轮）为 false。先确定它，再判断 done。',
    );
  }
  lines.push(
    '',
    '## 何时结束（done）',
    ...doneRule(task.stage),
    'done 为 true 时，reply 写一句简短的结束语，它不会发给 agent。',
    '',
    '## 输出',
    '- 文字中需要引号时一律用中文引号「」，不要用英文双引号。',
    '- agent 用文字提问或汇报时（即使文字里列出了 A/B 之类的选项）：reply 是你要发给 agent 的话，在 reply 里写出你的选择。',
    '',
    '## AskUserQuestion 的回答格式',
    'agent 用选项提问时，answers 中每个问题对应一个键：「问题 1」是 question_1，「问题 2」是 question_2，依此类推。',
    '- optionNumbers 是所选选项的编号（「选项 1」即 1）。只能选一项的问题给一个编号；可多选的问题给出所选的全部编号。选了选项时 otherAnswer 为空字符串。',
    '- 没有合适的选项时 optionNumbers 为空数组，并在 otherAnswer 写你自己的简短回答。',
    '- reply 用一句话说明你的选择。',
  );
  return lines.join('\n');
}

function formatQuestions(questions: AskQuestion[]): string {
  return questions
    .map((q, i) =>
      [
        `问题 ${String(i + 1)}${q.header ? `（${q.header}）` : ''}：${q.question}${q.multiSelect ? '（可多选）' : ''}`,
        ...q.options.map(
          (o, j) =>
            `  - 选项 ${String(j + 1)}：${o.label}${o.description ? `（说明：${o.description}）` : ''}`,
        ),
      ].join('\n'),
    )
    .join('\n');
}

// 编号换回 AskUserQuestion 的回答：所选选项的 label（多选用 ", " 连接），或自己的回答
function answerText(where: string, question: AskQuestion, answer: QuestionAnswer): string {
  const { optionNumbers, otherAnswer } = answer;
  if (optionNumbers.length === 0) return otherAnswer;
  if (otherAnswer !== '') {
    throw new Error(
      `${where} 既选了选项 ${JSON.stringify(optionNumbers)} 又写了回答 ${JSON.stringify(otherAnswer)}`,
    );
  }
  if (!question.multiSelect && optionNumbers.length > 1) {
    throw new Error(`${where} 只能选一项，模拟用户选了 ${JSON.stringify(optionNumbers)}`);
  }
  if (new Set(optionNumbers).size !== optionNumbers.length) {
    throw new Error(`${where} 的选项编号重复：${JSON.stringify(optionNumbers)}`);
  }
  return optionNumbers
    .map((n) => {
      const option = question.options[n - 1];
      if (option === undefined) throw new Error(`${where} 没有选项 ${String(n)}`);
      return option.label;
    })
    .join(', ');
}

export function userPrompt(transcript: TranscriptEntry[], prompt: AgentPrompt): string {
  const history = transcript.map(
    (e) => `[${e.speaker === 'agent' ? 'agent' : '你'}]\n${e.content}`,
  );
  const latest =
    prompt.kind === 'text'
      ? ['## agent 最新一轮的文字', prompt.text]
      : ['## agent 用选项向你提问', formatQuestions(prompt.questions)];
  return [
    '## 之前的对话',
    history.length > 0 ? history.join('\n\n') : '（无）',
    '',
    ...latest,
    '',
    '以你扮演的人的身份作答。',
  ].join('\n');
}

// 有 dispatch gate 的大阶段（Contracts 7.4）：回答中不能出现 go；回答 gate 的这一轮 done 必须为 false，
// 文字提问的回答必须是固定的那一句。不满足时以原文失败
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
    throw new Error(`/${stage.id} 运行中模拟用户的回答出现了 go：${JSON.stringify(said)}`);
  }
  if (!output.answeringDispatchGate) return;
  if (output.done) {
    throw new Error(
      `/${stage.id} 运行中模拟用户在回答 dispatch gate 的这一轮给出 done: true（回答 gate 之后才能结束）：${JSON.stringify(output)}`,
    );
  }
  if (prompt.kind === 'text' && output.reply !== DISPATCH_GATE_REPLY) {
    throw new Error(
      `/${stage.id} 运行中模拟用户对 dispatch gate 的回答不是"${DISPATCH_GATE_REPLY}"：${JSON.stringify(output.reply)}`,
    );
  }
}

// agent 一轮结束（文字）或 AskUserQuestion 时调用；回答不满足约束直接抛错
export async function simulateUser(
  ctx: SimulatedUserContext,
  transcript: TranscriptEntry[],
  prompt: AgentPrompt,
): Promise<SimulatedReply> {
  const call = {
    model: models.simulatedUser,
    system: systemPrompt(ctx),
    user: userPrompt(transcript, prompt),
    maxTokens: 4096,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  };
  const stage = ctx.task.stage;
  const gate = stage?.dispatchGate === true;
  let reply: string;
  let done: boolean;
  let answeringDispatchGate: boolean | undefined;
  let answers: Record<string, string> | undefined;
  let selections: QuestionAnswer[] | undefined;
  let cost: { costUsd: number; model: string };
  if (prompt.kind === 'questions') {
    const result = await parseStructured({
      ...call,
      schema: questionOutput(prompt.questions, gate),
    });
    ({ reply, done, answeringDispatchGate } = result.value);
    cost = result;
    const given = result.value.answers;
    selections = prompt.questions.map((_, i) => {
      const answer = given[questionKey(i)];
      if (answer === undefined) throw new Error(`模拟用户没有回答问题 ${String(i + 1)}`);
      return answer;
    });
    const chosen = selections;
    answers = Object.fromEntries(
      prompt.questions.map((question, i): [string, string] => {
        const answer = chosen[i];
        if (answer === undefined) throw new Error(`模拟用户没有回答问题 ${String(i + 1)}`);
        return [question.question, answerText(`问题 ${String(i + 1)}`, question, answer)];
      }),
    );
  } else {
    const result = await parseStructured({ ...call, schema: textOutput(gate) });
    ({ reply, done, answeringDispatchGate } = result.value);
    cost = result;
  }
  rejectFiller(reply, answers);
  if (gate) {
    if (answeringDispatchGate === undefined)
      throw new Error('模拟用户的回答缺少 answeringDispatchGate');
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
    costUsd: cost.costUsd,
    model: cost.model,
  };
}
