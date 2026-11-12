import { type RefObject, useEffect } from 'react';

// Two scroll areas scroll in proportion: scrolling one moves the other to the same ratio
export function useScrollSync(
  first: RefObject<HTMLElement | null>,
  second: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    const a = first.current;
    const b = second.current;
    if (a === null || b === null) return;
    // The scroll event that the moved side fires afterwards must not move the first side back: it arrives a frame later (much later on a
    // busy machine), so it is recognised by the position it was moved to
    const movedTo = new Map<HTMLElement, number>();
    const follow = (source: HTMLElement, target: HTMLElement) => () => {
      const moved = source.scrollTop === movedTo.get(source);
      movedTo.delete(source);
      if (moved) return;
      const range = source.scrollHeight - source.clientHeight;
      const ratio = range <= 0 ? 0 : source.scrollTop / range;
      const from = target.scrollTop;
      target.scrollTop = ratio * (target.scrollHeight - target.clientHeight);
      // No scroll event fires when the position does not change
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
