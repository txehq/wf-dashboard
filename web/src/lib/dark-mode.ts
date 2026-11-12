import { useSyncExternalStore } from 'react';

// The page's light or dark theme: dark when the root element has the dark class (the .dark variables in index.css and Tailwind's dark variant);
// subscribers re-render when the class changes
const isDark = () => document.documentElement.classList.contains('dark');

function subscribe(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => {
    observer.disconnect();
  };
}

export const useDarkMode = () => useSyncExternalStore(subscribe, isDark);
