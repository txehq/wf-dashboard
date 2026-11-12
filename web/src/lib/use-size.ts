import { useEffect, useState } from 'react';

// An element's content size (ResizeObserver reports when observing starts and on each change, deferred to the next frame so one layout does not trigger it repeatedly);
// returns the ref to attach and the size, 0 while not attached
export function useSize() {
  const [element, setElement] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (element === null) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        setSize({ width: element.clientWidth, height: element.clientHeight });
      });
    });
    observer.observe(element);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [element]);
  return [setElement, size] as const;
}
