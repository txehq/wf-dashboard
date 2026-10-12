import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SquareTerminal } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { openInLive } from '@/lib/live-api';

// Sessions 页面的"Live"按钮（Contracts 14.5）：不在交互区就导入建一项，已有一项（包括已关闭的）就用那一项并恢复显示，
// 然后打开交互区并选中它的标签页。只导入，不启动进程
export function OpenInLiveButton({
  session,
  className,
}: {
  session: { id: string; liveId: string | null };
  className?: string;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const opening = useMutation({
    mutationFn: () => openInLive(session),
    onSuccess: async (liveId) => {
      await client.invalidateQueries({ queryKey: ['live'] });
      await client.invalidateQueries({ queryKey: ['sessions'] });
      await navigate(`/live?item=${liveId}`);
    },
  });
  return (
    <span className={`flex flex-col items-start gap-1 ${className ?? ''}`}>
      <Button
        variant="outline"
        size="sm"
        data-testid="open-in-live"
        disabled={opening.isPending}
        onClick={() => {
          opening.mutate();
        }}
      >
        <SquareTerminal />
        Live
      </Button>
      {opening.isError && (
        <span role="alert" className="text-xs text-destructive">
          {opening.error.message}
        </span>
      )}
    </span>
  );
}
