import { useSyncExternalStore } from 'react';

// 页面的明暗主题：根元素有 dark 这个 class 时为暗色（index.css 的 .dark 变量与 Tailwind 的 dark variant）；
// class 变化时订阅者重新渲染
const isDark = () => document.documentElement.classList.contains('dark');

function subscribe(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => {
    observer.disconnect();
  };
}

export const useDarkMode = () => useSyncExternalStore(subscribe, isDark);
