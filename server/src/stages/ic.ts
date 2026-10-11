import { z } from 'zod';
import type { Db } from '../db/index.js';
import { stageChecks } from '../db/schema.js';
import { parseStructured } from '../llm/client.js';
import { inputField, inputString, type RequestRow } from './rows.js';
import { IC_STAGE_DESCRIPTIONS, IC_STAGES, type IcStage } from './workflow.js';

export const BATCH_SIZE = 30;
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

// 只给 tool 调用依次编号（0、1、2…），回复文字不编号：模型回答的编号只能指向 tool 调用
function toolPositions(batch: Behaviour[]): number[] {
  return batch.flatMap((b, i) => (b.kind === 'tool' ? [i] : []));
}

export function behaviourLines(batch: Behaviour[]): string[] {
  let n = 0;
  return batch.map((b) => (b.kind === 'tool' ? `[${String(n++)}] ` : '    ') + summarize(b));
}

// 附在每个问题之后：编号范围，以及只看已经发生的调用
function answerRule(batch: Behaviour[]): string {
  const tools = toolPositions(batch).length;
  return `回答的编号只能是上面出现的 0 到 ${String(tools - 1)} 之一；回复文字里说接下来要做的事还没有发生，不算。`;
}

// 模型回答的编号 → 批内下标
export function batchIndexOf(batch: Behaviour[], toolNumber: number): number {
  const index = toolPositions(batch)[toolNumber];
  if (index === undefined) {
    throw new Error(
      `first_index ${String(toolNumber)} 超出这批的 tool 调用数 ${String(toolPositions(batch).length)}（请求 #${String(batch[0]?.seq)} – #${String(batch[batch.length - 1]?.seq)}）`,
    );
  }
  return index;
}

const BATCH_NOTE =
  '你只看到 agent 最新的一批行为（每行是一次 tool 调用或一段回复文字，已截断；只有 tool 调用带编号）。';

// acceptance 容易与实现中的手动试用混淆：只认它特有的产物与命令（Stage Markers 2.1）
const ACCEPTANCE_RULE =
  '- 进入 acceptance 需要该阶段特有的动作：调用 Skill acceptance、写 .acceptances/ 下的文件、或用 wf publish-artifact 发布验收报告；在终端、浏览器或命令行中手动试用、运行测试与检查输出都不算。';

// 模型先写分析再调用 respond；分析限制长度以减少 output
const BRIEF_RULE = '调用 respond 之前，先用不超过三句话分析，再提交结果。';

export const SYSTEM_PROMPT = `你判定一个编程 agent 在 /ic 工作流中是否已经进入下一个阶段。
阶段按固定顺序推进，不会回退：${IC_STAGES.join(' → ')}。fix-pr 内部的修复、重跑验收、再次 review 都属于 fix-pr。
${BATCH_NOTE}
判定规则：
- 只有当某条 tool 调用是下一阶段（或其后任一阶段）自身的动作时，才算进入；只是提到、计划、阅读或讨论该阶段，不算进入。回复文字只作为理解上下文的依据，不能作为进入的那一条。
- 调用 Skill 且 skill 名是某个阶段名（例如 "Skill: open-pr"），这一条就是进入该阶段的动作。
${ACCEPTANCE_RULE}
- 进入时，first_index 是第一条属于下一阶段或其后阶段的 tool 调用的编号；未进入时 advanced 为 false，first_index 为 null。
只输出 JSON：{"advanced": boolean, "first_index": number | null}。
${BRIEF_RULE}`;

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
    ...behaviourLines(batch),
    '',
    later.length
      ? `问题：这批行为中是否有一条 tool 调用已经是 ${next} 或其后阶段（${later.join('、')}）自身的动作？`
      : `问题：这批行为中是否有一条 tool 调用已经是 ${next} 自身的动作？`,
    answerRule(batch),
  ].join('\n');
}

export const StageVerdict = z
  .object({
    advanced: z.boolean(),
    first_index: z.number().int().min(0).nullable(),
  })
  .strict();
export type StageVerdict = z.infer<typeof StageVerdict>;

// schema 之外的约束：advanced 与 first_index 一致，编号在这批 tool 调用的范围内；不满足就抛错
export function checkVerdict(v: StageVerdict, batch: Behaviour[]): StageVerdict {
  if (v.advanced !== (v.first_index !== null)) {
    throw new Error(`verdict 不一致：${JSON.stringify(v)}`);
  }
  checkIndex(v.first_index, batch);
  return v;
}

const stageList = IC_STAGES.map((s) => `- ${s} —— ${IC_STAGE_DESCRIPTIONS[s]}`);

// 流程外：是否开始一轮、从哪个阶段开始
export const ENTER_SYSTEM_PROMPT = `你判定一个编程 agent 是否开始了 /ic 工作流的一轮，以及从哪个阶段开始。
/ic 的阶段按固定顺序推进：${IC_STAGES.join(' → ')}。一轮可以从任一阶段开始：已认领、已有分支或已有 draft PR 时，从缺少产物的那一步开始。
agent 目前在流程外。${BATCH_NOTE}
判定规则：
- 只有当某条 tool 调用是某个阶段自身的动作时，才算进入；只是提到、计划、阅读或讨论该阶段，不算进入。回复文字只作为理解上下文的依据，不能作为进入的那一条。
- 调用 Skill 且 skill 名是某个阶段名（例如 "Skill: open-pr"），这一条就是进入该阶段的动作；"Skill: ic" 是进入 claim。
- 流程外的普通开发工作（读代码、编辑、运行测试、提交、调研、讨论、查看 PR 列表）不算进入任何阶段；进入 implement 需要该阶段特有的动作，例如为工单建 worktree 与分支、写 .ic/checklist.md。
${ACCEPTANCE_RULE}
- 进入时，first_index 是第一条属于某个阶段的 tool 调用的编号，stage 是这一条所属的阶段；未进入时 entered 为 false，stage 与 first_index 为 null。
只输出 JSON：{"entered": boolean, "stage": string | null, "first_index": number | null}。
${BRIEF_RULE}`;

export function enterPrompt(batch: Behaviour[]): string {
  return [
    '当前状态：流程外',
    '/ic 的阶段：',
    ...stageList,
    '',
    '新增行为：',
    ...behaviourLines(batch),
    '',
    '问题：这批行为中是否有一条 tool 调用已经是 /ic 某个阶段自身的动作？如果有，是哪一条、属于哪个阶段？',
    answerRule(batch),
  ].join('\n');
}

export const EnterVerdict = z
  .object({
    entered: z.boolean(),
    stage: z.enum(IC_STAGES).nullable(),
    first_index: z.number().int().min(0).nullable(),
  })
  .strict();
export type EnterVerdict = z.infer<typeof EnterVerdict>;

function checkIndex(index: number | null, batch: Behaviour[]) {
  if (index !== null) batchIndexOf(batch, index);
}

export function checkEnterVerdict(v: EnterVerdict, batch: Behaviour[]): EnterVerdict {
  if (v.entered !== (v.first_index !== null) || v.entered !== (v.stage !== null)) {
    throw new Error(`verdict 不一致：${JSON.stringify(v)}`);
  }
  checkIndex(v.first_index, batch);
  return v;
}

// ready-for-review 之后：是否已离开这一轮
export const LEAVE_SYSTEM_PROMPT = `你判定一个编程 agent 是否已经离开 /ic 工作流的这一轮。
agent 当前处于最后一个阶段 ready-for-review —— ${IC_STAGE_DESCRIPTIONS['ready-for-review']}
ready-for-review 自身的动作：调用 Skill ready-for-review；查看 PR 的 head 与 CI（gh pr view、gh pr checks）、核对 review 线程与需求清单；gh pr ready；把工单移到 review 状态；发 "Ready for review" 评论。
${BATCH_NOTE}
判定规则：
- 第一条不属于 ready-for-review 自身动作的 tool 调用，就是离开这一轮的那一条：例如合并 PR、修改代码、开始与这轮工单无关的工作、开始新的一轮（新的工单或新的 PR）。
- 回复文字只作为理解上下文的依据，不能作为离开的那一条。
- 离开时 first_index 是这一条的编号；仍在 ready-for-review 时 left 为 false，first_index 为 null。
只输出 JSON：{"left": boolean, "first_index": number | null}。
${BRIEF_RULE}`;

export function leavePrompt(batch: Behaviour[]): string {
  return [
    `当前阶段：ready-for-review —— ${IC_STAGE_DESCRIPTIONS['ready-for-review']}`,
    '',
    '新增行为：',
    ...behaviourLines(batch),
    '',
    '问题：这批行为中是否有一条 tool 调用已经不是 ready-for-review 自身的动作（表示 agent 已离开这一轮 /ic 流程）？',
    answerRule(batch),
  ].join('\n');
}

export const LeaveVerdict = z
  .object({
    left: z.boolean(),
    first_index: z.number().int().min(0).nullable(),
  })
  .strict();
export type LeaveVerdict = z.infer<typeof LeaveVerdict>;

export function checkLeaveVerdict(v: LeaveVerdict, batch: Behaviour[]): LeaveVerdict {
  if (v.left !== (v.first_index !== null)) {
    throw new Error(`verdict 不一致：${JSON.stringify(v)}`);
  }
  checkIndex(v.first_index, batch);
  return v;
}

// 判定状态：一轮中的某个阶段，或流程外
export type IcState = IcStage | 'outside';

// 状态变化的那一条行为。stage 为 outside 表示从这一条起离开流程；
// inclusive 表示这一条本身仍属于离开的那一轮（同一条命令里 gh pr ready 之后直接合并）。
// cycle：0 为调用开始时已在进行的一轮，本次调用中新开始的轮次依次为 1、2…
// method：skill 为 Skill 调用直接定的边界，llm 为模型判定
export interface IcBoundary {
  cycle: number;
  stage: IcState;
  seq: number;
  toolCallId: string;
  summary: string;
  method: 'skill' | 'llm';
  inclusive?: boolean;
}

// Contracts 5「ic 的确定性边界」：批中第一条 skill 名是当前状态之后某个 ic 阶段的 Skill 调用
// （流程外时任一 ic 阶段）。Skill ic 只表示进入流程，不指定阶段，不在这里匹配
export function skillAdvance(
  state: IcState,
  batch: Behaviour[],
): { index: number; stage: IcStage } | null {
  const after = state === 'outside' ? 0 : IC_STAGES.indexOf(state) + 1;
  for (const [index, b] of batch.entries()) {
    if (b.kind !== 'tool' || b.name !== 'Skill') continue;
    const skill = inputString(b.input, 'skill');
    const stage = IC_STAGES.find((s) => s === skill);
    if (stage !== undefined && IC_STAGES.indexOf(stage) >= after) return { index, stage };
  }
  return null;
}

interface Question<T> {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  check: (v: T, batch: Behaviour[]) => T;
  // 写入 stage_checks.next_stage
  target: string;
  entered: (v: T) => boolean;
  // 模型回答的那一条在批内的下标
  index: (v: T) => number | null;
}

function questionFor(state: IcState, batch: Behaviour[]): Question<unknown> {
  const position = (toolNumber: number | null) =>
    toolNumber === null ? null : batchIndexOf(batch, toolNumber);
  if (state === 'outside') {
    const q: Question<EnterVerdict> = {
      system: ENTER_SYSTEM_PROMPT,
      user: enterPrompt(batch),
      schema: EnterVerdict,
      check: checkEnterVerdict,
      target: 'enter',
      entered: (v) => v.entered,
      index: (v) => position(v.first_index),
    };
    return q as Question<unknown>;
  }
  if (state === 'ready-for-review') {
    const q: Question<LeaveVerdict> = {
      system: LEAVE_SYSTEM_PROMPT,
      user: leavePrompt(batch),
      schema: LeaveVerdict,
      check: checkLeaveVerdict,
      target: 'outside',
      entered: (v) => v.left,
      index: (v) => position(v.first_index),
    };
    return q as Question<unknown>;
  }
  const q: Question<StageVerdict> = {
    system: SYSTEM_PROMPT,
    user: userPrompt(state, batch),
    schema: StageVerdict,
    check: checkVerdict,
    target: nextStage(state),
    entered: (v) => v.advanced,
    index: (v) => position(v.first_index),
  };
  return q as Question<unknown>;
}

// 判定进度：已判完的批数 / 总批数，以及本次判定已花费的金额
export interface IcProgress {
  batchesDone: number;
  batchesTotal: number;
  costUsd: number;
}

// 批内下标对应的请求 seq；下标已由 batchIndexOf 校验，不存在时是判定代码的错误
function seqAt(batch: Behaviour[], index: number): number {
  const b = batch[index];
  if (b === undefined)
    throw new Error(`批内下标 ${String(index)} 超出批大小 ${String(batch.length)}`);
  return b.seq;
}

async function judgeBatch<T>(
  db: Db,
  args: { sessionId: string; model: string },
  state: IcState,
  batch: Behaviour[],
  q: Question<T>,
): Promise<{ verdict: T; costUsd: number }> {
  const first = batch[0];
  const last = batch[batch.length - 1];
  if (first === undefined || last === undefined) throw new Error('空批次不能判定');
  const result = await parseStructured({
    model: args.model,
    system: q.system,
    user: q.user,
    schema: q.schema,
    // 判定模型可配置：默认开启 adaptive thinking 的模型（如 Sonnet 5）思考也占 max_tokens，留出余量
    maxTokens: 16000,
  });
  const verdict = q.check(result.value, batch);
  const index = q.index(verdict);
  const u = result.usage;
  db.insert(stageChecks)
    .values({
      sessionId: args.sessionId,
      workflow: 'ic',
      currentStage: state,
      nextStage: q.target,
      fromSeq: first.seq,
      toSeq: last.seq,
      inputChars: q.system.length + q.user.length,
      entered: q.entered(verdict),
      enteredAtSeq: index === null ? null : seqAt(batch, index),
      answer: JSON.stringify(verdict),
      model: result.model,
      inputTokens: u.inputTokens + u.cacheReadTokens + u.cacheWrite5mTokens + u.cacheWrite1hTokens,
      outputTokens: u.outputTokens,
      costUsd: result.costUsd,
    })
    .run();
  return { verdict, costUsd: result.costUsd };
}

// 一次状态变化：批内下标、变化后的状态与判定方式
interface Step {
  index: number;
  next: IcState;
  method: IcBoundary['method'];
}

// 问模型：回答"否"时 step 为 null
async function askModel(
  db: Db,
  args: { sessionId: string; model: string },
  state: IcState,
  batch: Behaviour[],
): Promise<{ step: Step | null; costUsd: number }> {
  const q = questionFor(state, batch);
  const { verdict, costUsd } = await judgeBatch(db, args, state, batch, q);
  const index = q.index(verdict);
  if (index === null) return { step: null, costUsd };
  let next: IcState;
  if (state === 'outside') {
    const entered = (verdict as EnterVerdict).stage;
    if (entered === null) throw new Error('进入流程时 stage 不能为空');
    next = entered;
  } else if (state === 'ready-for-review') {
    next = 'outside';
  } else {
    next = nextStage(state);
  }
  return { step: { index, next, method: 'llm' }, costUsd };
}

// 实时与离线共用：从 current 起判定新增行为，按 BATCH_SIZE 条一批。
// 批中有当前状态之后某个 ic 阶段的 Skill 调用时，直接前移到该阶段，不问模型；否则问模型。
// 每次状态变化后，从变化的那一条起对新状态立即再判，直到不再变化。
// 流程外问是否进入、进入哪个阶段；阶段中问是否进入下一阶段或其后阶段；ready-for-review 问是否已离开。
// model 由调用方传入当前设置的阶段判定模型；onProgress 在开始、每次模型调用与每批判完后调用
export async function advanceIc(
  db: Db,
  args: {
    sessionId: string;
    current: IcState;
    behaviours: Behaviour[];
    model: string;
    onProgress?: (progress: IcProgress) => void;
  },
): Promise<{ stage: IcState; boundaries: IcBoundary[] }> {
  let state = args.current;
  let cycle = 0;
  const boundaries: IcBoundary[] = [];
  const progress: IcProgress = {
    batchesDone: 0,
    batchesTotal: Math.ceil(args.behaviours.length / BATCH_SIZE),
    costUsd: 0,
  };
  const report = () => args.onProgress?.({ ...progress });
  report();
  for (let start = 0; start < args.behaviours.length; start += BATCH_SIZE) {
    let batch = args.behaviours.slice(start, start + BATCH_SIZE);
    // 批首是否为刚进入 ready-for-review 的那一条
    let rfrAtHead = false;
    // 批首是否为刚离开一轮的那一条
    let leftAtHead: IcBoundary | null = null;
    // 只剩回复文字的批次不可能有状态变化，不调用模型
    while (batch.some((b) => b.kind === 'tool')) {
      const skill = skillAdvance(state, batch);
      let step: Step | null;
      if (skill !== null) {
        step = { index: skill.index, next: skill.stage, method: 'skill' };
      } else {
        const asked = await askModel(db, args, state, batch);
        progress.costUsd += asked.costUsd;
        report();
        step = asked.step;
      }
      if (step === null) break;
      const { index, next, method } = step;
      const target = batch[index];
      if (target?.kind !== 'tool') throw new Error('first_index 必须指向 tool 调用');
      if (state === 'outside') {
        // 离开那一条同时是 ready-for-review 自身的动作（gh pr ready 后在同一条命令里合并）：
        // 这一条属于刚离开的那一轮，不开始新的一轮
        if (leftAtHead !== null && index === 0 && next === 'ready-for-review') {
          leftAtHead.inclusive = true;
          leftAtHead = null;
          batch = batch.slice(1);
          continue;
        }
        cycle += 1;
      }
      const boundary: IcBoundary = {
        cycle,
        stage: next,
        seq: target.seq,
        toolCallId: target.toolCallId,
        summary: summarize(target),
        method,
      };
      boundaries.push(boundary);
      // 离开落在进入 ready-for-review 的同一条上：这一条仍属于 ready-for-review，流程外从下一条开始判定
      const leavesOnEntry = state === 'ready-for-review' && rfrAtHead && index === 0;
      if (leavesOnEntry) boundary.inclusive = true;
      leftAtHead = next === 'outside' && !leavesOnEntry ? boundary : null;
      state = next;
      rfrAtHead = state === 'ready-for-review';
      batch = batch.slice(leavesOnEntry ? 1 : index);
    }
    progress.batchesDone += 1;
    report();
  }
  return { stage: state, boundaries };
}

// 离线整份判定：从 ic 的第一个粗判标志所在的请求起，以流程外为初始状态；之前的请求不可能属于 /ic 的阶段
export function judgeIcSession(
  db: Db,
  sessionId: string,
  main: RequestRow[],
  startSeq: number,
  model: string,
  onProgress: (progress: IcProgress) => void,
): Promise<{ stage: IcState; boundaries: IcBoundary[] }> {
  return advanceIc(db, {
    sessionId,
    current: 'outside',
    behaviours: behavioursOf(main.filter((r) => r.seq >= startSeq)),
    model,
    onProgress,
  });
}
