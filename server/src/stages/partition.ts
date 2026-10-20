import { z } from 'zod';
import { displayUserText } from '../api/user-text.js';
import type { StageStatus } from '../db/schema.js';
import { codexSkillOfCall } from '../ingest/codex-skill.js';
import type { WorkflowDefinition } from '../workflows/schema.js';
import { inputString } from './rows.js';

// 阶段划分（Contracts 第 5 节、16.6）：按 Skill 调用与用户输入的 slash 命令把主 agent 的请求线性切块，不调用模型。
// 切块规则读 workflow 定义：一组 workflow（内置的 lfg 与 ic 一起，其他 workflow 单独）的入口与小阶段的顺序，
// 加上小阶段的 repeatable 与 allowInside
export type Partition = readonly WorkflowDefinition[];

export const markerKinds = ['skill', 'command'] as const;

// 进入阶段的那次调用
export const Evidence = z.object({
  seq: z.number(),
  kind: z.enum(markerKinds),
  text: z.string(),
});
export type Evidence = z.infer<typeof Evidence>;

// 一个切块标记：name 为小阶段 id，或 workflow id（入口命令）
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
  workflow: z.string(),
  // 开启这一轮的用户输入；由 Skill 调用开启时为空
  label: z.string().nullable(),
  startSeq: z.number(),
  // 已进入的小阶段，按进入顺序（即阶段顺序）
  stages: z.array(EnteredStage),
});
type CycleState = z.infer<typeof CycleState>;

// 折叠的状态：全部轮次按开始顺序排列，各 workflow 混排，最后一轮为当前轮次
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

const isEntry = (partition: Partition, name: string) => partition.some((w) => w.id === name);

const stageIndex = (workflow: WorkflowDefinition, name: string) =>
  workflow.stages.findIndex((s) => s.id === name);

// 小阶段所在的 workflow：当前轮次的 workflow 有这个小阶段时取它（不同 workflow 可以有同名小阶段），否则取第一个
function stageOf(
  partition: Partition,
  current: string | undefined,
  name: string,
): { workflow: WorkflowDefinition; index: number } | null {
  const candidates = partition
    .map((workflow) => ({ workflow, index: stageIndex(workflow, name) }))
    .filter((c) => c.index !== -1);
  return candidates.find((c) => c.workflow.id === current) ?? candidates[0] ?? null;
}

const isMarker = (partition: Partition, m: Marker) =>
  isEntry(partition, m.name) || stageOf(partition, undefined, m.name) !== null;

interface MainRequest {
  seq: number;
  timestamp: Date;
  toolCalls: { name: string; input: unknown; isError?: boolean }[];
}

interface UserInput {
  kind: string;
  timestamp: Date;
  text: string;
}

// 每条主请求上的标记：用户消息落在它之后的第一条请求上（时间不早于消息）；最后一条请求之后的用户消息还没有请求，不产生标记
export function stageItems(
  partition: Partition,
  main: MainRequest[],
  users: UserInput[],
): StageItem[] {
  const items = main.map((r) => ({ seq: r.seq, markers: [] as Marker[] }));
  let i = 0;
  for (const m of users) {
    if (m.kind !== 'user') continue;
    const marker = commandOf(m.text);
    if (marker === null || !isMarker(partition, marker)) continue;
    const at = m.timestamp.getTime();
    while (i < main.length && (main[i]?.timestamp.getTime() ?? 0) < at) i++;
    items[i]?.markers.push(marker);
  }
  for (const [j, r] of main.entries()) {
    for (const call of r.toolCalls) {
      // Claude Code 的 Skill 调用；Codex 以 exec_command 执行 cat <skill>/SKILL.md 加载 skill（Contracts 25.2）
      const codexSkill = codexSkillOfCall(call);
      const marker =
        call.name === 'Skill'
          ? skillMarker(call.input)
          : codexSkill === null
            ? null
            : { kind: 'skill' as const, name: codexSkill, text: `Skill: ${codexSkill}` };
      if (marker !== null && isMarker(partition, marker)) items[j]?.markers.push(marker);
    }
  }
  return items;
}

function apply(partition: Partition, cycles: CycleState[], seq: number, marker: Marker) {
  const evidence: Evidence = { seq, kind: marker.kind, text: marker.text };
  const label = marker.kind === 'command' ? (marker.text.split('\n')[0] ?? marker.text) : null;
  // workflow 的入口：开始这个 workflow 的新一轮
  if (isEntry(partition, marker.name)) {
    cycles.push({ workflow: marker.name, label, startSeq: seq, stages: [] });
    return;
  }
  const current = cycles.at(-1);
  const found = stageOf(partition, current?.workflow, marker.name);
  if (found === null) {
    throw new Error(`${marker.name} 不是 ${partition.map((w) => w.id).join('、')} 的阶段`);
  }
  const { workflow, index } = found;
  const entered = { stage: marker.name, startSeq: seq, entries: 1, evidence };
  const open = () => {
    cycles.push({ workflow: workflow.id, label, startSeq: seq, stages: [entered] });
  };
  if (current?.workflow !== workflow.id) {
    open();
    return;
  }
  const last = current.stages.at(-1);
  // 入口命令开启的一轮还没有进入任何小阶段：任一小阶段都在当前之后
  if (last === undefined) {
    current.stages.push(entered);
    return;
  }
  const at = stageIndex(workflow, last.stage);
  const lastStage = workflow.stages[at];
  if (lastStage === undefined) throw new Error(`workflow ${workflow.id} 没有小阶段 ${last.stage}`);
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
  partition: Partition,
  state: StageState,
  items: StageItem[],
): StageState {
  const cycles = structuredClone(state.cycles);
  for (const item of items) {
    for (const marker of item.markers) apply(partition, cycles, item.seq, marker);
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
  workflow: string;
  // 这个 workflow 的第几轮，从 1 开始
  index: number;
  label: string;
  startSeq: number;
  endSeq: number;
  spans: StageSpan[];
}

// 状态在 lastSeq（主 session 的最后一条请求）时的各轮各阶段。session 中的最后一个阶段为 active；
// finished（session 属于已到终态的 run）时为 done
export function cyclesOf(
  partition: Partition,
  state: StageState,
  lastSeq: number,
  finished: boolean,
): Cycle[] {
  const counts = new Map<string, number>();
  const lastCycle = state.cycles.length - 1;
  return state.cycles.map((c, i): Cycle => {
    const index = (counts.get(c.workflow) ?? 0) + 1;
    counts.set(c.workflow, index);
    const order = partition.find((w) => w.id === c.workflow)?.stages.map((s) => s.id);
    if (order === undefined) throw new Error(`划分所用的 workflow 中没有 ${c.workflow}`);
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
      workflow: c.workflow,
      index,
      label: c.label ?? `第 ${String(index)} 轮`,
      startSeq: c.startSeq,
      endSeq,
      spans,
    };
  });
}
