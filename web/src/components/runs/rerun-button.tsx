import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { rerunnable, rerunRun, type RunSummary } from '@/lib/runs-api';

// Contracts 10: a failed, cancelled or invalidated run can be rerun; on success, open the new run
export function RerunButton({ run, className }: { run: RunSummary; className?: string }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const rerun = useMutation({
    mutationFn: () => rerunRun(run.id),
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: ['runs'] });
      await navigate(`/runs/${created.id}`);
    },
  });
  if (!rerunnable(run)) return null;
  return (
    <span className={className}>
      <Button
        variant="outline"
        size="sm"
        disabled={rerun.isPending}
        data-testid="rerun"
        title="Run the same task and variant again in the same batch. The original run is kept."
        onClick={() => {
          rerun.mutate();
        }}
      >
        <RotateCcw />
        {rerun.isPending ? 'Rerunning…' : 'Rerun'}
      </Button>
      {rerun.isError && (
        <span role="alert" className="ml-2 text-xs text-destructive">
          {rerun.error.message}
        </span>
      )}
    </span>
  );
}
