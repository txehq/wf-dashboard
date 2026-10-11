import { CheckCircle2, Circle, CircleDot, SkipForward, type LucideIcon } from 'lucide-react';
import type { StageEvidence, StageStatus, StageView, WorkflowCycle } from '@/lib/sessions-api';

// 轮次名称：由 Skill 调用开启的一轮标签本身就是"第 N 轮"
export function cycleName(c: WorkflowCycle): string {
  const ordinal = `第 ${String(c.index)} 轮`;
  return c.label === ordinal ? ordinal : `${ordinal} · ${c.label}`;
}

// 进入阶段的那次调用的种类
export const evidenceKindLabel: Record<StageEvidence['kind'], string> = {
  skill: 'Skill 调用',
  command: '用户输入的命令',
};

// fix-pr 显示修复轮数，其他阶段显示调用次数；没有进入的阶段为 null
export function entriesText(view: StageView): string | null {
  if (view.entries === 0) return null;
  return view.stage === 'fix-pr'
    ? `修复 ${String(view.entries)} 轮`
    : `调用 ${String(view.entries)} 次`;
}

// 状态同时由图标、文字和边框样式区分，颜色只是附加
export const statusMeta: Record<
  StageStatus,
  { label: string; icon: LucideIcon; iconClass: string }
> = {
  done: { label: '完成', icon: CheckCircle2, iconClass: 'text-[var(--viz-status-good-text)]' },
  active: { label: '进行中', icon: CircleDot, iconClass: 'text-[var(--viz-series-1)]' },
  skipped: { label: '跳过', icon: SkipForward, iconClass: 'text-muted-foreground' },
  'not-reached': { label: '未到达', icon: Circle, iconClass: 'text-muted-foreground' },
};
