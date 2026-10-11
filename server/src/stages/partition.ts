import { z } from 'zod';
import { displayUserText } from '../api/user-text.js';
import { type StageStatus, type Workflow, workflows } from '../db/schema.js';
import { inputString } from './rows.js';
import { IC_STAGES, LFG_STAGES } from './workflow.js';

// 阶段划分（Contracts 第 5 节）：按 Skill 调用与用户输入的 slash 命令把主 agent 的请求线性切块，不调用模型

export const STAGES: Record<Workflow, readonly string[]> = { lfg: LFG_STAGES, ic: IC_STAGES };

export const markerKinds = ['skill', 'command'] as const;

// 进入阶段的那次调用
export const Evidence = z.object({
  seq: z.number(),
  kind: z.enum(markerKinds),
  text: z.string(),
});
export type Evidence = z.infer<typeof Evidence>;

// 一个切块标记：name 为阶段名，或命令 lfg / ic
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
  workflow: z.enum(workflows),
  // 开启这一轮的用户输入；由 Skill 调用开启时为空
  label: z.string().nullable(),
  startSeq: z.number(),
  // 已进入的阶段，按进入顺序（即阶段顺序）
  stages: z.array(EnteredStage),
});
type CycleState = z.infer<typeof CycleState>;

// 折叠的状态：全部轮次按开始顺序排列，lfg 与 ic 混排，最后一轮为当前轮次
export const StageState = z.object({
  cycles: z.array(CycleState),
});
export type StageState = z.infer<typeof StageState>;

export const initialStageState = (): StageState => ({ cycles: [] });

function stageOf(name: string): { workflow: Workflow; index: number } | null {
  for (const workflow of workflows) {
    const index = STAGES[workflow].indexOf(name);
    if (index !== -1) return { workflow, index };
  }
  return null;
}

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

const isMarker = (m: Marker) =>
  stageOf(m.name) !== null || (m.kind === 'command' && (m.name === 'lfg' || m.name === 'ic'));

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
export function stageItems(main: MainRequest[], users: UserInput[]): StageItem[] {
  const items = main.map((r) => ({ seq: r.seq, markers: [] as Marker[] }));
  let i = 0;
  for (const m of users) {
    if (m.kind !== 'user') continue;
    const marker = commandOf(m.text);
    if (marker === null || !isMarker(marker)) continue;
    const at = m.timestamp.getTime();
    while (i < main.length && (main[i]?.timestamp.getTime() ?? 0) < at) i++;
    items[i]?.markers.push(marker);
  }
  for (const [j, r] of main.entries()) {
    for (const call of r.toolCalls) {
      if (call.name !== 'Skill') continue;
      const marker = skillMarker(call.input);
      if (marker !== null && isMarker(marker)) items[j]?.markers.push(marker);
    }
  }
  return items;
}

function apply(cycles: CycleState[], seq: number, marker: Marker) {
  const evidence: Evidence = { seq, kind: marker.kind, text: marker.text };
  const label = marker.kind === 'command' ? (marker.text.split('\n')[0] ?? marker.text) : null;
  if (marker.kind === 'command' && (marker.name === 'lfg' || marker.name === 'ic')) {
    cycles.push({ workflow: marker.name, label, startSeq: seq, stages: [] });
    return;
  }
  const found = stageOf(marker.name);
  if (found === null) throw new Error(`${marker.name} 不是阶段名`);
  const { workflow, index } = found;
  const entered = { stage: marker.name, startSeq: seq, entries: 1, evidence };
  const open = () => {
    cycles.push({ workflow, label, startSeq: seq, stages: [entered] });
  };
  const current = cycles.at(-1);
  if (current?.workflow !== workflow) {
    open();
    return;
  }
  const last = current.stages.at(-1);
  // /lfg、/ic 开启的一轮还没有进入任何阶段：任一阶段都在当前之后
  if (last === undefined) {
    current.stages.push(entered);
    return;
  }
  const at = STAGES[workflow].indexOf(last.stage);
  // 只有 fix-pr 再次出现时留在 fix-pr 并计次（修复轮数）；fix-pr 中重跑验收也属于 fix-pr
  if (last.stage === 'fix-pr' && (marker.name === 'fix-pr' || marker.name === 'acceptance')) {
    if (marker.name === 'fix-pr') last.entries += 1;
    return;
  }
  // 当前阶段之后的阶段：切到那个阶段；第一个阶段、当前阶段本身与之前的阶段：开始新一轮
  if (index > at) current.stages.push(entered);
  else open();
}

// 把新的请求依次折叠进状态；同一组请求一次折叠与分几次折叠的结果相同
export function foldStages(state: StageState, items: StageItem[]): StageState {
  const cycles = structuredClone(state.cycles);
  for (const item of items) for (const marker of item.markers) apply(cycles, item.seq, marker);
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
  workflow: Workflow;
  // 这个 workflow 的第几轮，从 1 开始
  index: number;
  label: string;
  startSeq: number;
  endSeq: number;
  spans: StageSpan[];
}

// 状态在 lastSeq（主 session 的最后一条请求）时的各轮各阶段。session 中的最后一个阶段为 active；
// finished（session 属于已到终态的 run）时为 done
export function cyclesOf(state: StageState, lastSeq: number, finished: boolean): Cycle[] {
  const counts: Record<Workflow, number> = { lfg: 0, ic: 0 };
  const lastCycle = state.cycles.length - 1;
  return state.cycles.map((c, i): Cycle => {
    counts[c.workflow] += 1;
    const index = counts[c.workflow];
    const endSeq = (state.cycles[i + 1]?.startSeq ?? lastSeq + 1) - 1;
    const entered = new Map(c.stages.map((s, k) => [s.stage, k]));
    const spans = STAGES[c.workflow].map((stage, order): StageSpan => {
      const k = entered.get(stage);
      if (k === undefined) {
        const later = c.stages.find((s) => STAGES[c.workflow].indexOf(s.stage) > order);
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
      workflow: c.workflow,
      index,
      label: c.label ?? `第 ${String(index)} 轮`,
      startSeq: c.startSeq,
      endSeq,
      spans,
    };
  });
}
