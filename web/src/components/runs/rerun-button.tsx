import { useMutation, useQueryClient } from '@tanstack/react-query';
import { RotateCcw } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { rerunnable, rerunRun, type RunSummary } from '@/lib/runs-api';

// Contracts 10：失败、取消或已标为无效的 run 可以重跑；成功后打开新 run 的详情
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
        title="在同一个 batch 中用同一 task 与 variant 再跑一次，原 run 保持不变"
        onClick={() => {
          rerun.mutate();
        }}
      >
        <RotateCcw />
        {rerun.isPending ? '正在重跑…' : '重跑'}
      </Button>
      {rerun.isError && (
        <span role="alert" className="ml-2 text-xs text-destructive">
          {rerun.error.message}
        </span>
      )}
    </span>
  );
}
