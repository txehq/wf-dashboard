import { LaunchBatch } from '@/components/runs/launch-batch';
import { RunList } from '@/components/runs/run-list';
import { RunSettings } from '@/components/runs/run-settings';
import { useRunEvents } from '@/lib/runs-api';

export function RunsPage() {
  useRunEvents();
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">Runs</h1>
        <p className="text-sm text-muted-foreground">
          Start evaluation runs and follow their progress and conversations live.
        </p>
      </div>
      <LaunchBatch />
      <RunSettings />
      <RunList />
    </div>
  );
}
