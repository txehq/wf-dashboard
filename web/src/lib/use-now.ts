import { useEffect, useState } from 'react';

// 每秒刷新一次的当前时间；enabled 为假时不启动计时器
export function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [enabled]);
  return now;
}
