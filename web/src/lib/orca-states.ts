import type { OrcaRunView } from '@/lib/live-api';

// The states of Orca sessions as the topology drawer and the topology page show them (Contracts 35.4, 40.2)

export type OrcaState = OrcaRunView['coordinator']['state'];

export const stateLabel: Record<OrcaState, string> = {
  working: 'Working',
  idle: 'Idle',
  waiting: 'Waiting for answer',
  succeeded: 'Succeeded',
  failed: 'Failed',
  exited: 'Exited',
};

// The groups sessions fall into, in the order they are shown: the drawer groups a Run's workers by them, the page
// filters by them
export const groups = [
  { key: 'working', label: 'Working', states: ['working'] },
  { key: 'waiting', label: 'Waiting', states: ['waiting', 'idle'] },
  { key: 'exited', label: 'Exited', states: ['succeeded', 'failed', 'exited'] },
] as const satisfies readonly { key: string; label: string; states: readonly OrcaState[] }[];
export type GroupKey = (typeof groups)[number]['key'];

export const stateTone: Record<OrcaState, string> = {
  working: 'bg-[var(--viz-status-good)]',
  idle: 'bg-muted-foreground/50',
  waiting: 'bg-amber-500',
  succeeded: 'bg-[var(--viz-status-good)]/60',
  failed: 'bg-[var(--viz-status-serious)]',
  exited: 'bg-muted-foreground/30',
};

export const engineOf = (agent: string | null) =>
  agent === 'claude' || agent === 'codex' ? agent : null;
