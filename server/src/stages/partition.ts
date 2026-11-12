import { z } from 'zod';
import { displayUserText } from '../api/user-text.js';
import type { StageStatus } from '../db/schema.js';
import { codexSkillsOfCall } from '../ingest/codex-skill.js';
import type { WorkflowDefinition } from '../workflows/schema.js';
import { inputString } from './rows.js';

// Stage partition (Contracts section 5, 16.6): splits the main agent's requests linearly by Skill calls and slash
// commands the user typed, without calling a model. The rules come from the workflow definitions: the entries and
// stage order of a group of workflows (built-in lfg and ic together, every other workflow alone), plus each stage's
// repeatable and allowInside
export type Partition = readonly WorkflowDefinition[];

export const markerKinds = ['skill', 'command'] as const;

// The call that entered the stage
export const Evidence = z.object({
  seq: z.number(),
  kind: z.enum(markerKinds),
  text: z.string(),
});
export type Evidence = z.infer<typeof Evidence>;

// A split marker: name is a stage id, or a workflow id (entry command)
export interface Marker {
  kind: (typeof markerKinds)[number];
  name: string;
  text: string;
}

// A main agent request and the markers on it (first the commands typed before it, then its Skill calls, each in order)
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
  // The user input that opened this cycle; null when a Skill call opened it
  label: z.string().nullable(),
  startSeq: z.number(),
  // Stages entered so far, in entry order (which is stage order)
  stages: z.array(EnteredStage),
});
type CycleState = z.infer<typeof CycleState>;

// Folded state: all cycles in start order, workflows interleaved; the last cycle is the current one
export const StageState = z.object({
  cycles: z.array(CycleState),
});
export type StageState = z.infer<typeof StageState>;

export const initialStageState = (): StageState => ({ cycles: [] });

const COMMAND_NAME = /<command-name>\/([^<\s]+)<\/command-name>/;

// The slash command in a user message; null when it is not a command
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

// The workflow a stage belongs to: the current cycle's workflow if it has the stage (different workflows may share
// stage names), otherwise the first one
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

// A skill Codex injected as a <skill> message (an injected row in session_skills)
interface InjectedSkill {
  timestamp: Date;
  name: string;
}

// The markers on each main request: typed commands and Codex-injected skills go to the first request at or after
// their time; those after the last request have no request yet and produce no marker. An injected skill counts as
// a command of the message where the user mentioned it as $<skill>, and that message is recorded as its text
export function stageItems(
  partition: Partition,
  main: MainRequest[],
  users: UserInput[],
  injected: InjectedSkill[],
): StageItem[] {
  const items = main.map((r) => ({ seq: r.seq, markers: [] as Marker[] }));
  const typed = users.filter((m) => m.kind === 'user');
  const inputs = [
    ...typed.flatMap((m) => {
      const marker = commandOf(m.text);
      return marker === null ? [] : [{ at: m.timestamp.getTime(), marker }];
    }),
    ...injected.map((s) => {
      const at = s.timestamp.getTime();
      const said = typed.findLast((m) => m.timestamp.getTime() <= at);
      if (said === undefined) throw new Error(`No user message before injected skill ${s.name}`);
      return {
        at,
        marker: { kind: 'command' as const, name: s.name, text: displayUserText(said.text) },
      };
    }),
  ].sort((a, b) => a.at - b.at);
  let i = 0;
  for (const { at, marker } of inputs) {
    if (!isMarker(partition, marker)) continue;
    while (i < main.length && (main[i]?.timestamp.getTime() ?? 0) < at) i++;
    items[i]?.markers.push(marker);
  }
  for (const [j, r] of main.entries()) {
    for (const call of r.toolCalls) {
      // A Claude Code Skill call; Codex loads a skill by reading <skill>/SKILL.md with cat via exec_command (Contracts 25.2)
      const markers =
        call.name === 'Skill'
          ? [skillMarker(call.input)]
          : codexSkillsOfCall(call).map((name) => ({
              kind: 'skill' as const,
              name,
              text: `Skill: ${name}`,
            }));
      for (const marker of markers) {
        if (marker === null || !isMarker(partition, marker)) continue;
        // A command (slash command, Codex $<skill> injection) already handed the skill to this request: reading the
        // same skill right after via a Skill call or cat reads what it was given and is not another entry
        const previous = items[j]?.markers.at(-1);
        if (previous?.kind === 'command' && previous.name === marker.name) continue;
        items[j]?.markers.push(marker);
      }
    }
  }
  return items;
}

function apply(partition: Partition, cycles: CycleState[], seq: number, marker: Marker) {
  const evidence: Evidence = { seq, kind: marker.kind, text: marker.text };
  const label = marker.kind === 'command' ? (marker.text.split('\n')[0] ?? marker.text) : null;
  // A workflow entry starts a new cycle of that workflow. The entry of a single-skill workflow (whose only stage has
  // its name) also enters that stage; if the stage is repeatable and the current cycle is already in it, count it
  const entry = partition.find((w) => w.id === marker.name);
  if (entry !== undefined) {
    const only =
      entry.stages.length === 1 && entry.stages[0]?.id === entry.id ? entry.stages[0] : null;
    const current = cycles.at(-1);
    const last = current?.stages.at(-1);
    if (only?.repeatable === true && current?.workflow === entry.id && last?.stage === entry.id) {
      last.entries += 1;
      return;
    }
    const stages = only === null ? [] : [{ stage: entry.id, startSeq: seq, entries: 1, evidence }];
    cycles.push({ workflow: marker.name, label, startSeq: seq, stages });
    return;
  }
  const current = cycles.at(-1);
  const found = stageOf(partition, current?.workflow, marker.name);
  if (found === null) {
    throw new Error(`${marker.name} is not a stage of ${partition.map((w) => w.id).join(', ')}`);
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
  // A cycle opened by an entry command has entered no stage yet: every stage comes after the current position
  if (last === undefined) {
    current.stages.push(entered);
    return;
  }
  const at = stageIndex(workflow, last.stage);
  const lastStage = workflow.stages[at];
  if (lastStage === undefined)
    throw new Error(`Workflow ${workflow.id} has no stage ${last.stage}`);
  // A repeatable stage that appears again stays current and is counted (fix-pr repair rounds)
  if (lastStage.repeatable === true && marker.name === last.stage) {
    last.entries += 1;
    return;
  }
  // Calling a stage listed in allowInside from the current stage is not a switch (rerunning acceptance in fix-pr)
  if (lastStage.allowInside?.includes(marker.name) === true) return;
  // A later stage: switch to it; the first stage, the current stage itself or an earlier one: start a new cycle
  if (index > at) current.stages.push(entered);
  else open();
}

// Folds new requests into the state in order; folding a set of requests at once or in several parts gives the same result
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
  // Main session seq, inclusive; skipped is [s, s-1] (s is the start of the next entered stage), not-reached is null
  startSeq: number | null;
  endSeq: number | null;
  entries: number;
  evidence: Evidence | null;
}

export interface Cycle {
  workflow: string;
  // Cycle number within this workflow, from 1
  index: number;
  label: string;
  startSeq: number;
  endSeq: number;
  spans: StageSpan[];
}

// The cycles and stages of the state at lastSeq (the main session's last request). The session's last stage is
// active, or done when finished (the session belongs to a run in a final state)
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
    if (order === undefined)
      throw new Error(`The partition's workflows do not include ${c.workflow}`);
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
      if (s === undefined) throw new Error(`Stage ${String(k)} does not exist`);
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
      label: c.label ?? `Round ${String(index)}`,
      startSeq: c.startSeq,
      endSeq,
      spans,
    };
  });
}
