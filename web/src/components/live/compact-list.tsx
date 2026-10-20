import { useQuery } from '@tanstack/react-query';
import { PanelLeftOpen } from 'lucide-react';
import { EngineLogo, PurposeBand, PurposeIcon } from '@/components/live/live-identity';
import { liveListQuery } from '@/lib/live-api';

// 用户点"收起交互列表"后 Live 左侧的列表收成窄条（Contracts 26.1），把宽度让给终端：每项只留色带、
// 用途与引擎标志，悬停显示名字，点击打开；顶部的按钮恢复成完整的列表
export function CompactLiveList({
  active,
  onOpen,
  onExpand,
}: {
  active: string | null;
  onOpen: (id: string) => void;
  onExpand: () => void;
}) {
  const list = useQuery(liveListQuery(false));
  return (
    <div className="flex flex-col items-center gap-1" data-testid="live-list-compact">
      <button
        type="button"
        className="rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
        aria-label="展开交互列表"
        title="展开交互列表"
        data-testid="live-list-expand"
        onClick={onExpand}
      >
        <PanelLeftOpen className="size-4" />
      </button>
      <ul className="flex w-full flex-col gap-1" aria-label="交互 session">
        {(list.data ?? []).map((live) => (
          <li key={live.id}>
            <button
              type="button"
              title={live.title}
              aria-label={live.title}
              aria-current={active === live.id}
              data-live={live.id}
              data-testid="live-compact-item"
              className="flex w-full items-stretch gap-1 rounded-md border py-1.5 pr-1 pl-1 hover:bg-muted/50 aria-[current=true]:border-foreground"
              onClick={() => {
                onOpen(live.id);
              }}
            >
              <PurposeBand purpose={live.purpose} />
              <span className="flex flex-1 flex-col items-center gap-1">
                <PurposeIcon live={live} className="size-3.5 text-muted-foreground" />
                <EngineLogo engine={live.engine} className="size-3.5" />
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
