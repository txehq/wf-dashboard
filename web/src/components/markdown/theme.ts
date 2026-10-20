import markdownDark from 'github-markdown-css/github-markdown-dark.css?inline';
import 'github-markdown-css/github-markdown-light.css';
import '@/components/diff/colors.css';
import './syntax.css';
import './markdown.css';

// 明暗两种主题随页面（Contracts 21.1）：亮色的样式直接加载；暗色的样式嵌套在 .dark 之下，
// 页面的根元素有 dark 这个 class 时生效。代码高亮的颜色是 syntax.css 中随主题切换的变量
const style = document.createElement('style');
style.dataset.wfd = 'markdown-dark';
style.textContent = `.dark {\n${markdownDark}\n}`;
document.head.append(style);
