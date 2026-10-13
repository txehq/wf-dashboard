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
    // 被带动的一侧随后发出的 scroll 事件不再带动回去
    let follower: HTMLElement | null = null;
    let release = 0;
    const follow = (source: HTMLElement, target: HTMLElement) => () => {
      if (follower === source) return;
      const range = source.scrollHeight - source.clientHeight;
      const ratio = range <= 0 ? 0 : source.scrollTop / range;
      follower = target;
      target.scrollTop = ratio * (target.scrollHeight - target.clientHeight);
      window.clearTimeout(release);
      release = window.setTimeout(() => {
        follower = null;
      }, 80);
    };
    const onA = follow(a, b);
    const onB = follow(b, a);
    a.addEventListener('scroll', onA, { passive: true });
    b.addEventListener('scroll', onB, { passive: true });
    return () => {
      window.clearTimeout(release);
      a.removeEventListener('scroll', onA);
      b.removeEventListener('scroll', onB);
    };
  }, [first, second]);
}
