import { useEffect, useState } from 'react';

// 元素的内部尺寸（ResizeObserver 在开始观察时与每次变化时报告，放到下一帧，避免在同一次布局中反复触发）；
// 返回挂到元素上的 ref 与尺寸，没有挂上时为 0
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
