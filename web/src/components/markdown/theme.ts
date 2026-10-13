import { useSyncExternalStore } from 'react';
import markdownDark from 'github-markdown-css/github-markdown-dark.css?inline';
import highlightDark from 'highlight.js/styles/github-dark.css?inline';
import 'highlight.js/styles/github.css';
import 'github-markdown-css/github-markdown-light.css';
import '@/components/diff/colors.css';
import './markdown.css';

// 明暗两种主题随页面（Contracts 21.1）：亮色的样式直接加载；暗色的两份样式嵌套在 .dark 之下，
// 页面的根元素有 dark 这个 class 时生效
const style = document.createElement('style');
style.dataset.wfd = 'markdown-dark';
style.textContent = `.dark {\n${highlightDark}\n${markdownDark}\n}`;
document.head.append(style);

const isDark = () => document.documentElement.classList.contains('dark');

function subscribe(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => {
    observer.disconnect();
  };
}

export const useDarkMode = () => useSyncExternalStore(subscribe, isDark);
