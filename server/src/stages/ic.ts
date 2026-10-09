import { z } from 'zod';
import type { Db } from '../db/index.js';
import { stageChecks } from '../db/schema.js';
import { models, parseStructured } from '../llm/client.js';
import { inputField, inputString, type RequestRow } from './rows.js';
import { IC_STAGE_DESCRIPTIONS, IC_STAGES, type IcStage } from './workflow.js';

export const BATCH_SIZE = 20;
export const MAX_ITEM_CHARS = 300;

// 一条行为：主 session 中一段回复文字或一次 tool 调用
export type Behaviour =
  | { seq: number; kind: 'text'; text: string }
  | { seq: number; kind: 'tool'; toolCallId: string; name: string; input: unknown };

// 每个请求先放回复文字，再按顺序放 tool 调用；thinking、tool_result 与子代理请求不放入
export function behavioursOf(main: RequestRow[]): Behaviour[] {
  const out: Behaviour[] = [];
  for (const row of main) {
    if (row.agentId !== null) throw new Error(`请求 ${row.messageId} 属于子代理，不能作为行为`);
    if (row.text !== null && row.text.trim() !== '') {
      out.push({ seq: row.seq, kind: 'text', text: row.text });
    }
    for (const call of row.toolCalls) {
      out.push({
        seq: row.seq,
        kind: 'tool',
        toolCallId: call.id,
        name: call.name,
        input: call.input,
      });
    }
  }
  return out;
}

function toolSummary(b: Extract<Behaviour, { kind: 'tool' }>): string {
  const field = (key: string) =>
    inputString(b.input, key) ?? JSON.stringify(inputField(b.input, key));
  switch (b.name) {
    case 'Bash':
    case 'Monitor':
      return `${b.name}: ${field('command')}`;
    case 'Skill': {
      const args = inputString(b.input, 'args');
      return `Skill: ${field('skill')}${args ? ` ${args}` : ''}`;
    }
    case 'Write':
      return `Write: ${field('file_path')} ${field('content')}`;
    case 'Edit':
      return `Edit: ${field('file_path')} ${field('new_string')}`;
    case 'Read':
      return `Read: ${field('file_path')}`;
    case 'Agent':
      return `Agent(${inputString(b.input, 'subagent_type') ?? 'general-purpose'}): ${field('description')} ${field('prompt')}`;
    default:
      return `${b.name}: ${JSON.stringify(b.input)}`;
  }
}

// 空白压成一个空格，按 code point 截断到 300 个字符
export function summarize(b: Behaviour): string {
  const body = b.kind === 'text' ? `回复: ${b.text}` : toolSummary(b);
  const flat = body.replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > MAX_ITEM_CHARS ? `${chars.slice(0, MAX_ITEM_CHARS).join('')}…` : flat;
}

export const SYSTEM_PROMPT = `你判定一个编程 agent 在 /ic 工作流中是否已经进入下一个阶段。
阶段按固定顺序推进，不会回退：${IC_STAGES.join(' → ')}。fix-pr 内部的修复、重跑验收、再次 review 都属于 fix-pr。
你只看到 agent 最新的一批行为（每条是一次 tool 调用或一段回复文字，已截断）。
判定规则：
- 只有当某条 tool 调用是下一阶段（或其后任一阶段）自身的动作时，才算进入；只是提到、计划、阅读或讨论该阶段，不算进入。回复文字只作为理解上下文的依据，不能作为进入的那一条。
- 调用 Skill 且 skill 名是某个阶段名（例如 "Skill: open-pr"），这一条就是进入该阶段的动作。
- 进入时，first_index 是第一条属于下一阶段或其后阶段的 tool 调用的编号；未进入时 advanced 为 false，first_index 为 null。
只输出 JSON：{"advanced": boolean, "first_index": number | null}。`;

function nextStage(stage: IcStage): IcStage {
  const next = IC_STAGES[IC_STAGES.indexOf(stage) + 1];
  if (next === undefined) throw new Error(`${stage} 之后没有阶段`);
  return next;
}

export function userPrompt(current: IcStage, batch: Behaviour[]): string {
  const next = nextStage(current);
  const later = IC_STAGES.slice(IC_STAGES.indexOf(next) + 1);
  return [
    `当前阶段：${current} —— ${IC_STAGE_DESCRIPTIONS[current]}`,
    `下一阶段：${next} —— ${IC_STAGE_DESCRIPTIONS[next]}`,
    ...(later.length
      ? ['其后阶段：', ...later.map((s) => `- ${s} —— ${IC_STAGE_DESCRIPTIONS[s]}`)]
      : ['其后阶段：无']),
    '',
    '新增行为：',
    ...batch.map((b, i) => `[${String(i)}] ${summarize(b)}`),
    '',
    later.length
      ? `问题：这批行为中是否有一条 tool 调用已经是 ${next} 或其后阶段（${later.join('、')}）自身的动作？`
      : `问题：这批行为中是否有一条 tool 调用已经是 ${next} 自身的动作？`,
  ].join('\n');
}

export const StageVerdict = z
  .object({
    advanced: z.boolean(),
    first_index: z.number().int().min(0).nullable(),
  })
  .strict();
export type StageVerdict = z.infer<typeof StageVerdict>;

// schema 之外的三条约束，不满足就抛错
export function checkVerdict(v: StageVerdict, batch: Behaviour[]): StageVerdict {
  if (v.advanced !== (v.first_index !== null)) {
    throw new Error(`verdict 不一致：${JSON.stringify(v)}`);
  }
  if (v.first_index !== null) {
    const target = batch[v.first_index];
    if (target === undefined) {
      throw new Error(`first_index ${String(v.first_index)} 超出批大小 ${String(batch.length)}`);
    }
    if (target.kind !== 'tool') {
      throw new Error(`first_index ${String(v.first_index)} 指向回复文字，不是 tool 调用`);
    }
  }
  return v;
}

export interface IcBoundary {
  stage: IcStage;
  seq: number;
  toolCallId: string;
  summary: string;
}

async function judgeBatch(
  db: Db,
  sessionId: string,
  current: IcStage,
  batch: Behaviour[],
): Promise<StageVerdict> {
  const first = batch[0];
  const last = batch[batch.length - 1];
  if (first === undefined || last === undefined) throw new Error('空批次不能判定');
  const user = userPrompt(current, batch);
  const result = await parseStructured({
    model: models.stageCheck,
    system: SYSTEM_PROMPT,
    user,
    schema: StageVerdict,
    maxTokens: 256,
  });
  const verdict = checkVerdict(result.value, batch);
  const u = result.usage;
  db.insert(stageChecks)
    .values({
      sessionId,
      workflow: 'ic',
      currentStage: current,
      nextStage: nextStage(current),
      fromSeq: first.seq,
      toSeq: last.seq,
      inputChars: SYSTEM_PROMPT.length + user.length,
      entered: verdict.advanced,
      enteredAtSeq: verdict.first_index === null ? null : (batch[verdict.first_index]?.seq ?? null),
      answer: JSON.stringify(verdict),
      model: result.model,
      inputTokens: u.inputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens,
      outputTokens: u.outputTokens,
      costUsd: result.costUsd,
    })
    .run();
  return verdict;
}

// 实时与离线共用：从 current 起判定新增行为，按 20 条一批；前进后从 first_index 起立即再判，直到"否"或到达 ready-for-review
export async function advanceIc(
  db: Db,
  args: { sessionId: string; current: IcStage; behaviours: Behaviour[] },
): Promise<{ stage: IcStage; boundaries: IcBoundary[] }> {
  let stage = args.current;
  const boundaries: IcBoundary[] = [];
  for (let start = 0; start < args.behaviours.length; start += BATCH_SIZE) {
    let batch = args.behaviours.slice(start, start + BATCH_SIZE);
    while (stage !== 'ready-for-review' && batch.length > 0) {
      const verdict = await judgeBatch(db, args.sessionId, stage, batch);
      if (verdict.first_index === null) break;
      const target = batch[verdict.first_index];
      if (target?.kind !== 'tool') {
        throw new Error('checkVerdict 之后 first_index 必须指向 tool 调用');
      }
      stage = nextStage(stage);
      boundaries.push({
        stage,
        seq: target.seq,
        toolCallId: target.toolCallId,
        summary: summarize(target),
      });
      batch = batch.slice(verdict.first_index);
    }
    if (stage === 'ready-for-review') break;
  }
  return { stage, boundaries };
}

// 离线整份判定：从 ic 开始的那条请求起，以 claim 为初始阶段
export function judgeIcSession(
  db: Db,
  sessionId: string,
  main: RequestRow[],
  startSeq: number,
): Promise<{ stage: IcStage; boundaries: IcBoundary[] }> {
  return advanceIc(db, {
    sessionId,
    current: 'claim',
    behaviours: behavioursOf(main.filter((r) => r.seq >= startSeq)),
  });
}
