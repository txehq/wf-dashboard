import { X } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { cn } from '@/lib/utils';

const MIN_WIDTH = 280;
// 抽屉最宽占它所在一行的这个比例，终端至少留下其余部分
const MAX_SHARE = 0.7;
// 打开时的宽度；拖动后由使用者记下
export const DRAWER_WIDTH = 480;

// 终端右侧的抽屉（Contracts 20.3）：左边缘可以拖动宽度，关上后终端恢复原宽度。只占终端这一行，不影响其他布局。
// width 是显示的宽度，拖动时把想要的宽度交给 onResize；maxWidth 是这一行留给抽屉的宽度（设计项的终端先保证
// 560 px，Contracts 26.1）。resizable 为 false 时没有拖动的把手（设计项覆盖在终端上的抽屉）
export function SideDrawer({
  title,
  onClose,
  width,
  onResize,
  maxWidth = Infinity,
  resizable = true,
  className,
  children,
}: {
  title: string;
  onClose: () => void;
  width: number;
  onResize?: (width: number) => void;
  maxWidth?: number;
  resizable?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const drawer = useRef<HTMLElement>(null);

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    const row = drawer.current?.parentElement;
    if (row === null || row === undefined) throw new Error('抽屉不在终端这一行中');
    if (onResize === undefined) throw new Error('可以拖动的抽屉没有 onResize');
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const right = row.getBoundingClientRect().right;
    const max = Math.min(row.clientWidth * MAX_SHARE, maxWidth);
    const move = (e: PointerEvent) => {
      onResize(Math.round(Math.min(max, Math.max(MIN_WIDTH, right - e.clientX))));
    };
    const stop = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', stop);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', stop);
  };

  return (
    <aside
      ref={drawer}
      aria-label={title}
      className={cn(
        'relative flex min-h-0 shrink-0 flex-col rounded-md border bg-background',
        className,
      )}
      style={{ width: Math.min(width, maxWidth) }}
      data-testid="side-drawer"
    >
      {resizable && (
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="拖动调整宽度"
          className="absolute inset-y-0 -left-1.5 z-10 w-3 cursor-col-resize hover:bg-primary/10"
          data-testid="side-drawer-handle"
          onPointerDown={startDrag}
        />
      )}
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <h2 className="truncate text-sm font-medium">{title}</h2>
        <button
          type="button"
          aria-label="关闭"
          className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={onClose}
        >
          <X className="size-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">{children}</div>
    </aside>
  );
}
