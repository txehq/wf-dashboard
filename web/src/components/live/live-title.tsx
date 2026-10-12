import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil } from 'lucide-react';
import { useState } from 'react';
import { renameLive } from '@/lib/live-api';

// 交互项的名字（Contracts 14.3）：双击或点铅笔图标改名，回车保存，Esc 取消；
// 保存失败时输入框保留，显示服务端的原文
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
  const [draft, setDraft] = useState<string | null>(null);
  const saving = useMutation({
    mutationFn: (next: string) => renameLive(liveId, next),
    onSuccess: async () => {
      setDraft(null);
      await client.invalidateQueries({ queryKey: ['live'] });
      await client.invalidateQueries({ queryKey: ['sessions'] });
    },
  });
  const edit = () => {
    saving.reset();
    setDraft(title);
  };

  if (draft !== null) {
    return (
      <span className="flex min-w-0 flex-col gap-1">
        <input
          // 打开时直接可以输入
          autoFocus
          aria-label="交互的名字"
          data-testid="live-title-input"
          className="h-7 w-full min-w-40 rounded border bg-background px-1.5 text-sm"
          value={draft}
          disabled={saving.isPending}
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          // 列表项与标签页本身是按钮：输入框中的点击与按键不触发它们
          onClick={(event) => {
            event.stopPropagation();
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') saving.mutate(draft);
            else if (event.key === 'Escape') setDraft(null);
          }}
          onBlur={() => {
            if (!saving.isPending && !saving.isError) setDraft(null);
          }}
        />
        {saving.isError && (
          <span role="alert" className="text-xs text-destructive">
            {saving.error.message}
          </span>
        )}
      </span>
    );
  }
  return (
    <span className="group flex min-w-0 items-center gap-1">
      <span
        className={className}
        data-testid="live-title"
        title={title}
        onDoubleClick={(event) => {
          event.stopPropagation();
          edit();
        }}
      >
        {title}
      </span>
      <span
        role="button"
        tabIndex={0}
        aria-label="改名"
        data-testid="live-rename"
        className="shrink-0 rounded p-0.5 text-muted-foreground opacity-60 group-hover:opacity-100 hover:bg-muted hover:text-foreground"
        onClick={(event) => {
          event.stopPropagation();
          edit();
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            event.stopPropagation();
            edit();
          }
        }}
      >
        <Pencil className="size-3" />
      </span>
    </span>
  );
}
