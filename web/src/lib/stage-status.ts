import {
  CheckCircle2,
  Circle,
  CircleDot,
  CircleSlash,
  SkipForward,
  type LucideIcon,
} from 'lucide-react';
import type { StageStatus, WorkflowCycle } from '@/lib/sessions-api';

// 轮次名称：标签取不到工单或 PR 编号时本身就是"第 N 轮"
export function cycleName(c: WorkflowCycle): string {
  const ordinal = `第 ${String(c.index)} 轮`;
  return c.label === ordinal ? ordinal : `${ordinal} · ${c.label}`;
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
  interrupted: { label: '中断', icon: CircleSlash, iconClass: 'text-[var(--viz-status-serious)]' },
};
