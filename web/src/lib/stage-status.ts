import { CheckCircle2, Circle, CircleDot, SkipForward, type LucideIcon } from 'lucide-react';
import type { StageEvidence, StageStatus, StageView, WorkflowCycle } from '@/lib/sessions-api';

// Cycle name: a cycle opened by a Skill call has the label "Round N" itself (server/src/stages/partition.ts)
export function cycleName(c: WorkflowCycle): string {
  const ordinal = `Round ${String(c.index)}`;
  return c.label === ordinal ? ordinal : `${ordinal} · ${c.label}`;
}

// Kind of call that entered the stage
export const evidenceKindLabel: Record<StageEvidence['kind'], string> = {
  skill: 'Skill call',
  command: 'User command',
};

// fix-pr shows fix rounds, other stages show call counts; null for stages never entered
export function entriesText(view: StageView): string | null {
  if (view.entries === 0) return null;
  const n = view.entries;
  return view.stage === 'fix-pr'
    ? `${String(n)} ${n === 1 ? 'fix round' : 'fix rounds'}`
    : `${String(n)} ${n === 1 ? 'call' : 'calls'}`;
}

// Status is told apart by icon, text and border style; color is only extra
export const statusMeta: Record<
  StageStatus,
  { label: string; icon: LucideIcon; iconClass: string }
> = {
  done: { label: 'Done', icon: CheckCircle2, iconClass: 'text-[var(--viz-status-good-text)]' },
  active: { label: 'In progress', icon: CircleDot, iconClass: 'text-[var(--viz-series-1)]' },
  skipped: { label: 'Skipped', icon: SkipForward, iconClass: 'text-muted-foreground' },
  'not-reached': { label: 'Not reached', icon: Circle, iconClass: 'text-muted-foreground' },
};
