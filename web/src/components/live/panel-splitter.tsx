import type { PointerEvent } from 'react';
import { cn } from '@/lib/utils';

// Draggable divider: while held, passes the pointer position (clientX for vertical, clientY for
// horizontal) to onDrag, and calls onEnd on release
export function PanelSplitter({
  orientation,
  label,
  testId,
  onDrag,
  onEnd,
}: {
  // vertical: a bar between left and right parts; horizontal: a bar between top and bottom parts
  orientation: 'vertical' | 'horizontal';
  label: string;
  testId: string;
  onDrag: (position: number) => void;
  onEnd?: () => void;
}) {
  const vertical = orientation === 'vertical';
  const position = (event: PointerEvent) => (vertical ? event.clientX : event.clientY);
  return (
    <div
      role="separator"
      aria-orientation={orientation}
      aria-label={label}
      data-testid={testId}
      className={cn(
        'group flex shrink-0 touch-none items-center justify-center',
        vertical ? 'w-2 cursor-col-resize' : 'h-2 cursor-row-resize',
      )}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
        onDrag(position(event));
      }}
      onPointerUp={(event) => {
        event.currentTarget.releasePointerCapture(event.pointerId);
        onEnd?.();
      }}
    >
      <span
        className={cn(
          'rounded-full bg-border group-hover:bg-foreground/40',
          vertical ? 'h-full w-px' : 'h-px w-full',
        )}
      />
    </div>
  );
}
