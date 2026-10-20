import { type RefObject, useEffect } from 'react';

// 两个滚动区域按比例同步滚动：滚动其中一个，另一个跟到相同的比例
export function useScrollSync(
  first: RefObject<HTMLElement | null>,
  second: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const a = first.current;
    const b = second.current;
    if (a === null || b === null) return;
    // 被带动的一侧随后发出的 scroll 事件不再带动回去：事件在之后的一帧才到（机器忙时可能晚很久），
    // 按带动后它所在的位置认出
    const movedTo = new Map<HTMLElement, number>();
    const follow = (source: HTMLElement, target: HTMLElement) => () => {
      const moved = source.scrollTop === movedTo.get(source);
      movedTo.delete(source);
      if (moved) return;
      const range = source.scrollHeight - source.clientHeight;
      const ratio = range <= 0 ? 0 : source.scrollTop / range;
      const from = target.scrollTop;
      target.scrollTop = ratio * (target.scrollHeight - target.clientHeight);
      // 位置没有变时不会有滚动事件
      if (target.scrollTop === from) movedTo.delete(target);
      else movedTo.set(target, target.scrollTop);
    };
    const onA = follow(a, b);
    const onB = follow(b, a);
    a.addEventListener('scroll', onA, { passive: true });
    b.addEventListener('scroll', onB, { passive: true });
    return () => {
      a.removeEventListener('scroll', onA);
      b.removeEventListener('scroll', onB);
    };
  }, [first, second]);
}
