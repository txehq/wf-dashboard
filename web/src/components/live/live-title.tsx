import { useQueryClient } from '@tanstack/react-query';
import { InlineRename } from '@/components/inline-rename';
import { renameLive } from '@/lib/live-api';

// Name of an interaction item (Contracts 14.3): after a rename, refresh where Live and Sessions show it
export function LiveTitle({
  liveId,
  title,
  className,
}: {
  liveId: string;
  title: string;
  className?: string;
}) {
  const client = useQueryClient();
  return (
    <InlineRename
      value={title}
      label="Interaction name"
      testId="live-title"
      {...(className === undefined ? {} : { className })}
      onSave={async (next) => {
        await renameLive(liveId, next);
        await client.invalidateQueries({ queryKey: ['live'] });
        await client.invalidateQueries({ queryKey: ['sessions'] });
      }}
    />
  );
}
