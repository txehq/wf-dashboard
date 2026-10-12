import { z } from 'zod';
import { displayUserText } from '../api/user-text.js';
import type { StageStatus } from '../db/schema.js';
import type { BigStageDefinition, WorkflowDefinition } from '../workflows/schema.js';
import { inputString } from './rows.js';

// 阶段划分（Contracts 第 5 节、16.6）：按 Skill 调用与用户输入的 slash 命令把主 agent 的请求线性切块，不调用模型。
// 切块规则读 workflow 定义：大阶段与小阶段的顺序，加上小阶段的 repeatable 与 allowInside

export const markerKinds = ['skill', 'command'] as const;

// 进入阶段的那次调用
export const Evidence = z.object({
  seq: z.number(),
  kind: z.enum(markerKinds),
  text: z.string(),
});
export type Evidence = z.infer<typeof Evidence>;

// 一个切块标记：name 为小阶段 id，或大阶段 id（入口命令）
export interface Marker {
  kind: (typeof markerKinds)[number];
  name: string;
  text: string;
}

// 一条主 agent 请求与落在它上面的标记（先是它之前输入的命令，再是它的 Skill 调用，各按出现顺序）
export interface StageItem {
  seq: number;
  markers: Marker[];
}

const EnteredStage = z.object({
  stage: z.string(),
  startSeq: z.number(),
  entries: z.number(),
  evidence: Evidence,
});

const CycleState = z.object({
  bigStage: z.string(),
  // 开启这一轮的用户输入；由 Skill 调用开启时为空
  label: z.string().nullable(),
  startSeq: z.number(),
  // 已进入的小阶段，按进入顺序（即阶段顺序）
  stages: z.array(EnteredStage),
});
type CycleState = z.infer<typeof CycleState>;

// 折叠的状态：全部轮次按开始顺序排列，各大阶段混排，最后一轮为当前轮次
export const StageState = z.object({
  cycles: z.array(CycleState),
});
export type StageState = z.infer<typeof StageState>;

export const initialStageState = (): StageState => ({ cycles: [] });

const COMMAND_NAME = /<command-name>\/([^<\s]+)<\/command-name>/;

// 用户消息中的 slash 命令；不是命令时为 null
function commandOf(text: string): Marker | null {
  const name = COMMAND_NAME.exec(text)?.[1];
  if (name === undefined) return null;
  return { kind: 'command', name, text: displayUserText(text) };
}

function skillMarker(input: unknown): Marker | null {
  const name = inputString(input, 'skill');
  if (name === null) return null;
  const args = inputString(input, 'args')?.trim() ?? '';
  return { kind: 'skill', name, text: args === '' ? `Skill: ${name}` : `Skill: ${name} ${args}` };
}

const isBigStage = (definition: WorkflowDefinition, name: string) =>
  definition.bigStages.some((s) => s.id === name);

const stageIndex = (bigStage: BigStageDefinition, name: string) =>
  bigStage.stages.findIndex((s) => s.id === name);

// 小阶段所在的大阶段：当前轮次的大阶段有这个小阶段时取它（不同大阶段可以有同名小阶段），否则取定义中的第一个
function stageOf(
  definition: WorkflowDefinition,
  current: string | undefined,
  name: string,
): { bigStage: BigStageDefinition; index: number } | null {
  const candidates = definition.bigStages
    .map((bigStage) => ({ bigStage, index: stageIndex(bigStage, name) }))
    .filter((c) => c.index !== -1);
  return candidates.find((c) => c.bigStage.id === current) ?? candidates[0] ?? null;
}

const isMarker = (definition: WorkflowDefinition, m: Marker) =>
  isBigStage(definition, m.name) || stageOf(definition, undefined, m.name) !== null;

interface MainRequest {
  seq: number;
  timestamp: Date;
  toolCalls: { name: string; input: unknown }[];
}

interface UserInput {
  kind: string;
  timestamp: Date;
  text: string;
}

// 每条主请求上的标记：用户消息落在它之后的第一条请求上（时间不早于消息）；最后一条请求之后的用户消息还没有请求，不产生标记
export function stageItems(
  definition: WorkflowDefinition,
  main: MainRequest[],
  users: UserInput[],
): StageItem[] {
  const items = main.map((r) => ({ seq: r.seq, markers: [] as Marker[] }));
  let i = 0;
  for (const m of users) {
    if (m.kind !== 'user') continue;
    const marker = commandOf(m.text);
    if (marker === null || !isMarker(definition, marker)) continue;
    const at = m.timestamp.getTime();
    while (i < main.length && (main[i]?.timestamp.getTime() ?? 0) < at) i++;
    items[i]?.markers.push(marker);
  }
  for (const [j, r] of main.entries()) {
    for (const call of r.toolCalls) {
      if (call.name !== 'Skill') continue;
      const marker = skillMarker(call.input);
      if (marker !== null && isMarker(definition, marker)) items[j]?.markers.push(marker);
    }
  }
  return items;
}

function apply(definition: WorkflowDefinition, cycles: CycleState[], seq: number, marker: Marker) {
  const evidence: Evidence = { seq, kind: marker.kind, text: marker.text };
  const label = marker.kind === 'command' ? (marker.text.split('\n')[0] ?? marker.text) : null;
  // 大阶段的入口：开始这个大阶段的新一轮
  if (isBigStage(definition, marker.name)) {
    cycles.push({ bigStage: marker.name, label, startSeq: seq, stages: [] });
    return;
  }
  const current = cycles.at(-1);
  const found = stageOf(definition, current?.bigStage, marker.name);
  if (found === null) throw new Error(`${marker.name} 不是 workflow ${definition.id} 的阶段`);
  const { bigStage, index } = found;
  const entered = { stage: marker.name, startSeq: seq, entries: 1, evidence };
  const open = () => {
    cycles.push({ bigStage: bigStage.id, label, startSeq: seq, stages: [entered] });
  };
  if (current?.bigStage !== bigStage.id) {
    open();
    return;
  }
  const last = current.stages.at(-1);
  // 入口命令开启的一轮还没有进入任何小阶段：任一小阶段都在当前之后
  if (last === undefined) {
    current.stages.push(entered);
    return;
  }
  const at = stageIndex(bigStage, last.stage);
  const lastStage = bigStage.stages[at];
  if (lastStage === undefined) throw new Error(`大阶段 ${bigStage.id} 没有小阶段 ${last.stage}`);
  // repeatable 的小阶段再次出现时留在当前阶段并计次（fix-pr 的修复轮数）
  if (lastStage.repeatable === true && marker.name === last.stage) {
    last.entries += 1;
    return;
  }
  // 在当前阶段中调用 allowInside 列出的小阶段不算切换（fix-pr 中重跑验收）
  if (lastStage.allowInside?.includes(marker.name) === true) return;
  // 当前阶段之后的阶段：切到那个阶段；第一个阶段、当前阶段本身与之前的阶段：开始新一轮
  if (index > at) current.stages.push(entered);
  else open();
}

// 把新的请求依次折叠进状态；同一组请求一次折叠与分几次折叠的结果相同
export function foldStages(
  definition: WorkflowDefinition,
  state: StageState,
  items: StageItem[],
): StageState {
  const cycles = structuredClone(state.cycles);
  for (const item of items) {
    for (const marker of item.markers) apply(definition, cycles, item.seq, marker);
  }
  return { cycles };
}

export interface StageSpan {
  stage: string;
  status: StageStatus;
  // 主 session seq，含端点；skipped 为 [s, s-1]（s 为之后进入的阶段的起点），not-reached 为空
  startSeq: number | null;
  endSeq: number | null;
  entries: number;
  evidence: Evidence | null;
}

export interface Cycle {
  bigStage: string;
  // 这个大阶段的第几轮，从 1 开始
  index: number;
  label: string;
  startSeq: number;
  endSeq: number;
  spans: StageSpan[];
}

// 状态在 lastSeq（主 session 的最后一条请求）时的各轮各阶段。session 中的最后一个阶段为 active；
// finished（session 属于已到终态的 run）时为 done
export function cyclesOf(
  definition: WorkflowDefinition,
  state: StageState,
  lastSeq: number,
  finished: boolean,
): Cycle[] {
  const counts = new Map<string, number>();
  const lastCycle = state.cycles.length - 1;
  return state.cycles.map((c, i): Cycle => {
    const index = (counts.get(c.bigStage) ?? 0) + 1;
    counts.set(c.bigStage, index);
    const order = definition.bigStages.find((s) => s.id === c.bigStage)?.stages.map((s) => s.id);
    if (order === undefined) throw new Error(`workflow ${definition.id} 没有大阶段 ${c.bigStage}`);
    const endSeq = (state.cycles[i + 1]?.startSeq ?? lastSeq + 1) - 1;
    const entered = new Map(c.stages.map((s, k) => [s.stage, k]));
    const spans = order.map((stage, position): StageSpan => {
      const k = entered.get(stage);
      if (k === undefined) {
        const later = c.stages.find((s) => order.indexOf(s.stage) > position);
        return later === undefined
          ? {
              stage,
              status: 'not-reached',
              startSeq: null,
              endSeq: null,
              entries: 0,
              evidence: null,
            }
          : {
              stage,
              status: 'skipped',
              startSeq: later.startSeq,
              endSeq: later.startSeq - 1,
              entries: 0,
              evidence: null,
            };
      }
      const s = c.stages[k];
      if (s === undefined) throw new Error(`第 ${String(k)} 个阶段不存在`);
      const next = c.stages[k + 1];
      const isLast = next === undefined;
      return {
        stage,
        status: isLast && i === lastCycle && !finished ? 'active' : 'done',
        startSeq: s.startSeq,
        endSeq: isLast ? endSeq : next.startSeq - 1,
        entries: s.entries,
        evidence: s.evidence,
      };
    });
    return {
      bigStage: c.bigStage,
      index,
      label: c.label ?? `第 ${String(index)} 轮`,
      startSeq: c.startSeq,
      endSeq,
      spans,
    };
  });
}
