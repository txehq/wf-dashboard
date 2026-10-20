import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SquareTerminal } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { openInLive } from '@/lib/live-api';

// Sessions 页面的"Live"按钮（Contracts 14.5）：不在交互区就导入建一项，已有一项（包括已关闭的）就用那一项并恢复显示，
// 然后打开交互区并选中它的标签页。只导入，不启动进程。icon：Sessions 列表中只显示图标，悬停显示说明，
// 失败时按钮变红、悬停显示原因
const LABEL = '在 Live 中打开';

export function OpenInLiveButton({
  session,
  className,
  icon = false,
}: {
  session: { id: string; liveId: string | null };
  className?: string;
  icon?: boolean;
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
  const onClick = () => {
    opening.mutate();
  };
  if (icon)
    return (
      <span className={className}>
        <Button
          variant="outline"
          size="icon-sm"
          data-testid="open-in-live"
          aria-label={LABEL}
          title={opening.isError ? `${LABEL}失败：${opening.error.message}` : LABEL}
          className={opening.isError ? 'border-destructive text-destructive' : undefined}
          disabled={opening.isPending}
          onClick={onClick}
        >
          <SquareTerminal />
        </Button>
        {opening.isError && (
          <span role="alert" className="sr-only">
            {opening.error.message}
          </span>
        )}
      </span>
    );
  return (
    <span className={`flex flex-col items-start gap-1 ${className ?? ''}`}>
      <Button
        variant="outline"
        size="sm"
        data-testid="open-in-live"
        disabled={opening.isPending}
        onClick={onClick}
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
