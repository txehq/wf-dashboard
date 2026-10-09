import { z } from 'zod';
import type { AskQuestion } from '../db/schema.js';
import { EVAL_PROJECT, EVAL_TEAM } from '../external/linear.js';
import { ORG } from '../external/github.js';
import { models, parseStructured } from '../llm/client.js';
import type { Task } from '../tasks/schema.js';

// dispatch gate 的固定回答（Spikes/Stage Markers 1.5）
export const DISPATCH_GATE_REPLY = '不派发，到此结束。';
const GO = /\bgo\b/i;

export interface SimulatedUserContext {
  task: Task;
  runId: string;
  // txehq/wfe-<runId>
  repo: string;
  // ic 的工单 identifier
  ticket: string | null;
  product: string;
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
  done: boolean;
  costUsd: number;
  model: string;
}

// 结构化输出不支持任意键的对象，answers 以数组输出后再转成 Record
const Output = z.object({
  reply: z.string(),
  answers: z.array(z.object({ question: z.string(), answer: z.string() })).nullable(),
  done: z.boolean(),
});

function facts(ctx: SimulatedUserContext): string[] {
  const common = [
    `- 工单系统：Linear 的 ${EVAL_TEAM} team，"${EVAL_PROJECT}" project。`,
    `- 代码托管：GitHub 组织 ${ORG}；本次运行的仓库是 ${ctx.repo}。`,
  ];
  if (ctx.task.kind === 'lfg') {
    return [
      ...common,
      `- 文档写进 Obsidian vault，product 是 "${ctx.product}"，feature slug 是 ${ctx.runId}。`,
    ];
  }
  return [...common, `- 要做的工单是 ${ctx.ticket ?? '（未建）'}。`];
}

function doneRule(task: Task): string {
  return task.kind === 'lfg'
    ? '这是 /lfg 运行。done 为 true 的条件（同时满足）：你在之前的对话中已经回答过 dispatch gate（不派发），并且 agent 最新一轮报告了结束状态。其他情况一律为 false。'
    : '这是 /ic 运行。done 为 true 的条件（满足其一）：agent 最新一轮报告 PR 已经标记为 ready for review（工单已移到 review 状态）；或 agent 明确报告无法继续。其他情况一律为 false。';
}

export function systemPrompt(ctx: SimulatedUserContext): string {
  const { task } = ctx;
  const lines = [
    '你在一次 Magi workflow 的评估运行中扮演用户，与一个编程 agent（Claude Code）对话。',
    '',
    '## 你扮演的人',
    task.persona.trim(),
    '',
    '## 你心里的完整需求（只在被问到时透露）',
    task.hiddenRequirements.trim(),
    '',
    '## 规则',
    '- 只回答 agent 问到的内容。被问到哪一部分就透露哪一部分需求，不要一次把全部需求倒出来，也不要主动补充没被问到的细节。',
    '- 始终保持这个人的身份、知识水平和说话方式。',
    '- 不要求 agent 跳过、合并或简化 workflow 的任何步骤；agent 请你确认、选择或审阅时，按这个人的立场作答。',
    '- 你不能打开链接、运行命令、操作任何外部系统，也不能替 agent 做调研；agent 请你做这些事时，如实说明你做不到。',
    '- 授权范围：agent 可以在上述 Linear project 中建工单，在 GitHub 组织 txehq 中建仓库与 PR，写 vault 的 Project Magi Eval/。被问到是否授权这些操作时回答可以；超出范围的操作不授权。',
    '',
    '## 评估环境的公共事实（agent 问到时如实回答）',
    ...facts(ctx),
  ];
  if (task.kind === 'lfg') {
    lines.push(
      '',
      '## dispatch gate',
      `agent 建完工单、展示执行计划并问是否派发（例如回复 go 或 go wave N 派发实现）时，回答固定为"${DISPATCH_GATE_REPLY}"。回答中绝不能出现 go 这个词。agent 用选项提问时，选择表示不派发的那个选项。`,
    );
  }
  lines.push(
    '',
    '## 何时结束（done）',
    doneRule(task),
    'done 为 true 时，reply 写一句简短的结束语，它不会发给 agent。',
    '',
    '## 输出',
    '- 文字中需要引号时一律用中文引号「」，不要用英文双引号。',
    '- agent 用文字提问或汇报时：reply 是你要发给 agent 的话，answers 为 null。',
    '- agent 用选项提问时：answers 为每个问题各给一项，question 是问题原文（一字不差），answer 是所选选项的 label 原文（只写 label，不带说明）；多选时用 ", " 连接多个 label；没有合适的选项时可以写你自己的简短回答。reply 用一句话说明你的选择。',
  );
  return lines.join('\n');
}

function formatQuestions(questions: AskQuestion[]): string {
  return questions
    .map((q, i) =>
      [
        `问题 ${String(i + 1)}${q.header ? `（${q.header}）` : ''}：${q.question}${q.multiSelect ? '（可多选）' : ''}`,
        ...q.options.map(
          (o) => `  - label：${o.label}${o.description ? `（说明：${o.description}）` : ''}`,
        ),
      ].join('\n'),
    )
    .join('\n');
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

// agent 一轮结束（文字）或 AskUserQuestion 时调用；回答不满足约束直接抛错
export async function simulateUser(
  ctx: SimulatedUserContext,
  transcript: TranscriptEntry[],
  prompt: AgentPrompt,
): Promise<SimulatedReply> {
  const result = await parseStructured({
    model: models.simulatedUser,
    system: systemPrompt(ctx),
    user: userPrompt(transcript, prompt),
    schema: Output,
    maxTokens: 4096,
  });
  const { reply, done } = result.value;
  let answers: Record<string, string> | undefined;
  if (prompt.kind === 'questions') {
    const given = result.value.answers ?? [];
    answers = Object.fromEntries(given.map((a) => [a.question, a.answer]));
    const expected = prompt.questions.map((q) => q.question).sort();
    if (JSON.stringify(Object.keys(answers).sort()) !== JSON.stringify(expected)) {
      throw new Error(
        `模拟用户回答的问题 ${JSON.stringify(Object.keys(answers))} 与提问 ${JSON.stringify(expected)} 不一致`,
      );
    }
  } else if (result.value.answers !== null && result.value.answers.length > 0) {
    throw new Error(
      `agent 没有用选项提问，模拟用户却给出了 answers：${JSON.stringify(result.value)}`,
    );
  }
  if (ctx.task.kind === 'lfg') {
    const said = [reply, ...Object.values(answers ?? {})];
    if (said.some((s) => GO.test(s))) {
      throw new Error(`lfg 运行中模拟用户的回答出现了 go：${JSON.stringify(said)}`);
    }
  }
  return {
    reply,
    ...(answers === undefined ? {} : { answers }),
    done,
    costUsd: result.costUsd,
    model: result.model,
  };
}
