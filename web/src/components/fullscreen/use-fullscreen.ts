import { createContext, useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { isFullscreenShortcut } from './shortcut';

const PARAM = 'fullscreen';

// 页面内全屏的状态（Contracts 20.1）：写在地址的 ?fullscreen=1 中，刷新后保持；快捷键 ⌃⇧F 切换，Esc 不退出。
// 进入时记下页面的滚动位置，退出后恢复
export function useFullscreen() {
  const [params, setParams] = useSearchParams();
  const active = params.get(PARAM) === '1';
  const scrollY = useRef(0);

  const set = (next: boolean) => {
    if (next === active) return;
    if (next) scrollY.current = window.scrollY;
    setParams(
      (current) => {
        const copy = new URLSearchParams(current);
        if (next) copy.set(PARAM, '1');
        else copy.delete(PARAM);
        return copy;
      },
      { replace: true },
    );
  };
  const toggle = () => {
    set(!active);
  };

  // 快捷键在捕获阶段处理，编辑器与终端收不到这个组合
  const toggleRef = useRef(toggle);
  useLayoutEffect(() => {
    toggleRef.current = toggle;
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!isFullscreenShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      toggleRef.current();
    };
    window.addEventListener('keydown', onKey, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true });
    };
  }, []);

  // 全屏时页面本身不滚动；退出后回到进入前的滚动位置
  useLayoutEffect(() => {
    if (!active) {
      window.scrollTo(0, scrollY.current);
      return;
    }
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [active]);

  return {
    active,
    enter: () => {
      set(true);
    },
    exit: () => {
      set(false);
    },
    toggle,
  };
}

export type Fullscreen = ReturnType<typeof useFullscreen>;

// 全屏区域内的子组件据此在进入与退出后重新计算尺寸（Monaco 的 layout、xterm 的 fit 与 PTY resize）
export const FullscreenContext = createContext<{ active: boolean }>({ active: false });

export function useFullscreenLayout(relayout: () => void) {
  const { active } = useContext(FullscreenContext);
  const relayoutRef = useRef(relayout);
  useLayoutEffect(() => {
    relayoutRef.current = relayout;
  });
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    // 等新的布局生效（class 变化后的下一帧）再量尺寸
    const frame = requestAnimationFrame(() => {
      relayoutRef.current();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [active]);
}
