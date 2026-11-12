import { Button } from '@/components/ui/button';
import { StageDetail } from '@/components/sessions/stage-detail';
import type { StageView, SubagentInfo, WorkflowCycle } from '@/lib/sessions-api';

// Contracts section 12: with a stage selected, Requests shows only that stage (the seq range of the chosen
// cycle and stage); "Show all" brings back every request. Shared by Sessions detail and Runs detail
export function StageRequests({
  sessionId,
  workflow,
  cycle,
  view,
  subagents,
  onShowAll,
}: {
  sessionId: string;
  // workflow id
  workflow: string;
  cycle: WorkflowCycle | undefined;
  view: StageView;
  subagents: SubagentInfo[];
  onShowAll: () => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-3" data-testid="stage-requests">
      <Button variant="outline" size="sm" className="self-start" onClick={onShowAll}>
        Show all
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
