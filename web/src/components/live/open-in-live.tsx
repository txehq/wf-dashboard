import { useMutation, useQueryClient } from '@tanstack/react-query';
import { SquareTerminal } from 'lucide-react';
import { useNavigate } from 'react-router';
import { Button } from '@/components/ui/button';
import { openInLive } from '@/lib/live-api';

// The "Live" button on the Sessions page (Contracts 14.5): imports a new item when the session is not
// in the workspace, or reuses its existing item (closed ones included) and restores it, then opens the
// workspace on its tab. Imports only, starts no process. icon: the Sessions list shows only the icon
// with a hover description; on failure the button turns red and the hover shows the reason
const LABEL = 'Open in Live';

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
          title={opening.isError ? `Couldn't open in Live: ${opening.error.message}` : LABEL}
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
