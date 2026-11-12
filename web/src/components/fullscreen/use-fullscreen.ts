import { createContext, useContext, useEffect, useLayoutEffect, useRef } from 'react';
import { useSearchParams } from 'react-router';
import { isFullscreenShortcut } from './shortcut';

const PARAM = 'fullscreen';

// In-page full screen state (Contracts 20.1): kept in the address as ?fullscreen=1 so it survives a refresh; ⌃⇧F toggles it, Esc does not exit.
// The page's scroll position is saved on entry and restored on exit
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

  // The shortcut is handled in the capture phase, so editors and terminals never receive it
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

  // The page itself does not scroll in full screen; on exit it returns to the scroll position from before
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

// Children of the full screen area use this to recompute their size after entering and exiting (Monaco layout, xterm fit and PTY resize)
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
    // Measure once the new layout applies (the frame after the class change)
    const frame = requestAnimationFrame(() => {
      relayoutRef.current();
    });
    return () => {
      cancelAnimationFrame(frame);
    };
  }, [active]);
}
