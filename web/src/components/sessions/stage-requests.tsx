import { Button } from '@/components/ui/button';
import { StageDetail } from '@/components/sessions/stage-detail';
import type { StageView, SubagentInfo, WorkflowCycle } from '@/lib/sessions-api';

// Contracts 第 12 节：选中阶段后请求明细只显示该阶段（所选轮次与阶段的 seq 区间），
// "显示全部"恢复全部请求。Sessions 详情与 Runs 详情共用
export function StageRequests({
  sessionId,
  workflow,
  cycle,
  view,
  subagents,
  onShowAll,
}: {
  sessionId: string;
  // 大阶段 id
  workflow: string;
  cycle: WorkflowCycle | undefined;
  view: StageView;
  subagents: SubagentInfo[];
  onShowAll: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="stage-requests">
      <Button variant="outline" size="sm" className="self-start" onClick={onShowAll}>
        显示全部
      </Button>
      <StageDetail
        sessionId={sessionId}
        workflow={workflow}
        cycle={cycle}
        view={view}
        subagents={subagents}
      />
    </div>
  );
}
