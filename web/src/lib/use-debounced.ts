import { useEffect, useState } from 'react';

// A value that updates only after input pauses for ms milliseconds (search boxes)
export function useDebounced(value: string, ms: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebounced(value);
    }, ms);
    return () => {
      clearTimeout(timer);
    };
  }, [value, ms]);
  return debounced;
}
