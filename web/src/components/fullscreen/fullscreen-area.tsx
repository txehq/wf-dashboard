import { Maximize2, Minimize2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { FULLSCREEN_SHORTCUT_LABEL } from './shortcut';
import { FullscreenContext } from './use-fullscreen';

// 可以全屏的工作区（Contracts 20.1）：全屏时铺满整个浏览器窗口（position: fixed; inset: 0，盖住导航与页面头部），
// 不用浏览器的 Fullscreen API。两种状态下是同一个元素，只换 class：子组件不重新挂载，编辑器的内容、光标与选区不变
export function FullscreenArea({
  active,
  className,
  activeClassName,
  children,
  testId,
}: {
  active: boolean;
  // 不全屏时的样式
  className?: string;
  // 全屏时另加的样式（铺满窗口之外的部分，例如内部的排列）
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
          // 不全屏时的尺寸、圆角与边框在全屏时去掉，铺满窗口
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

// 工作区右上角的按钮：进入全屏，全屏时为"退出全屏"；提示中写明快捷键
export function FullscreenButton({
  active,
  onToggle,
  size = 'sm',
}: {
  active: boolean;
  onToggle: () => void;
  size?: 'sm' | 'xs';
}) {
  const label = active ? '退出全屏' : '全屏';
  return (
    <Button
      size={size}
      variant="ghost"
      data-testid="fullscreen-toggle"
      aria-pressed={active}
      title={`${label}（${FULLSCREEN_SHORTCUT_LABEL}）`}
      onClick={onToggle}
    >
      {active ? <Minimize2 /> : <Maximize2 />}
      {label}
    </Button>
  );
}
