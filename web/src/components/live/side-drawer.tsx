import { X } from 'lucide-react';
import { type ReactNode, useRef } from 'react';
import { cn } from '@/lib/utils';

const MIN_WIDTH = 280;
// The drawer takes at most this share of its row; the terminal keeps the rest
const MAX_SHARE = 0.7;
// Width when opened; the caller remembers it after dragging
export const DRAWER_WIDTH = 480;

// Drawer to the right of the terminal (Contracts 20.3): its left edge drags to resize, and the terminal
// returns to its width when closed. It occupies only the terminal's row and leaves other layout alone.
// width is the displayed width; dragging passes the wanted width to onResize; maxWidth is the width the
// row leaves for the drawer (design items guarantee the terminal 560 px first, Contracts 26.1).
// With resizable false there is no drag handle (the drawer that overlays a design item's terminal)
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
    if (row === null || row === undefined) throw new Error('The drawer is not in the terminal row');
    if (onResize === undefined) throw new Error('A resizable drawer has no onResize');
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
          aria-label="Drag to resize"
          className="absolute inset-y-0 -left-1.5 z-10 w-3 cursor-col-resize hover:bg-primary/10"
          data-testid="side-drawer-handle"
          onPointerDown={startDrag}
        />
      )}
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <h2 className="truncate text-sm font-medium">{title}</h2>
        <button
          type="button"
          aria-label="Close"
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
