import markdownDark from 'github-markdown-css/github-markdown-dark.css?inline';
import 'github-markdown-css/github-markdown-light.css';
import '@/components/diff/colors.css';
import './syntax.css';
import './markdown.css';

// Light and dark themes follow the page (Contracts 21.1): the light styles load directly; the dark styles are nested under .dark
// and apply when the page root has the dark class. Code highlight colours are variables in syntax.css that switch with the theme
const style = document.createElement('style');
style.dataset.wfd = 'markdown-dark';
style.textContent = `.dark {\n${markdownDark}\n}`;
document.head.append(style);
