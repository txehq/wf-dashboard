import { useEffect, useState } from 'react';

// The current time, refreshed every second; no timer runs while enabled is false
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
