import { useQueryClient } from '@tanstack/react-query';
import { InlineRename } from '@/components/inline-rename';
import { renameLive } from '@/lib/live-api';

// 交互项的名字（Contracts 14.3）：改名后刷新 Live 与 Sessions 中显示它的地方
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
      label="交互的名字"
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
