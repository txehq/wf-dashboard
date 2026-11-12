import { Maximize2, Minimize2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { FULLSCREEN_SHORTCUT_LABEL } from './shortcut';
import { FullscreenContext } from './use-fullscreen';

// A workspace that can go full screen (Contracts 20.1): in full screen it fills the whole browser window (position: fixed; inset: 0, covering the navigation and page header),
// without the browser Fullscreen API. Both states use the same element with different classes: children do not remount, so editor content, cursor and selection stay
export function FullscreenArea({
  active,
  className,
  activeClassName,
  children,
  testId,
}: {
  active: boolean;
  // Classes when not in full screen
  className?: string;
  // Extra classes in full screen (beyond filling the window, for example the inner layout)
  activeClassName?: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <FullscreenContext.Provider value={{ active }}>
      <div
        data-testid={testId}
        data-fullscreen={active}
        className={cn(
          className,
          // In full screen the normal size, rounding and border go away and the area fills the window
          active &&
            'fixed inset-0 z-50 m-0 flex h-auto max-h-none min-h-0 w-auto max-w-none flex-col rounded-none border-0 bg-background',
          active && activeClassName,
        )}
      >
        {children}
      </div>
    </FullscreenContext.Provider>
  );
}

// The button at the workspace's top right: enters full screen, and reads "Exit full screen" while in it; the tooltip shows the shortcut
export function FullscreenButton({
  active,
  onToggle,
  size = 'sm',
}: {
  active: boolean;
  onToggle: () => void;
  size?: 'sm' | 'xs';
}) {
  const label = active ? 'Exit full screen' : 'Full screen';
  return (
    <Button
      size={size}
      variant="ghost"
      data-testid="fullscreen-toggle"
      aria-pressed={active}
      title={`${label} (${FULLSCREEN_SHORTCUT_LABEL})`}
      onClick={onToggle}
    >
      {active ? <Minimize2 /> : <Maximize2 />}
      {/* A narrow toolbar may keep only the icon (the Live design item toolbar); the name stays as the accessible name and tooltip */}
      <span data-toolbar-label>{label}</span>
    </Button>
  );
}
