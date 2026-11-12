import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { useDarkMode } from '@/lib/dark-mode';

// Use the locally bundled monaco, not the CDN
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

// Light and dark themes; every editor on the page follows the page theme (Monaco themes are global).
// Syntax colors match Markdown code blocks (components/markdown/syntax.css, GitHub prettylights); the diff
// view uses GitHub red and green (Contracts 21.3): line backgrounds match components/diff/colors.css,
// changed words get a lighter background with a border, and every syntax color reaches WCAG AA 4.5:1
// on both line and changed-word backgrounds
const syntax = {
  light: {
    text: '1f2328',
    keyword: 'cf222e',
    entity: '6639ba',
    constant: '0550ae',
    string: '0a3069',
    variable: '953800',
    comment: '59636e',
    tag: '116329',
  },
  dark: {
    text: 'e6edf3',
    keyword: 'ff7b72',
    entity: 'd2a8ff',
    constant: '79c0ff',
    string: 'a5d6ff',
    variable: 'ffa657',
    comment: '9198a1',
    tag: '7ee787',
  },
};

function rules(c: (typeof syntax)['light']): monaco.editor.ITokenThemeRule[] {
  return [
    { token: '', foreground: c.text },
    { token: 'comment', foreground: c.comment },
    { token: 'keyword', foreground: c.keyword },
    { token: 'storage', foreground: c.keyword },
    { token: 'operator', foreground: c.keyword },
    { token: 'string', foreground: c.string },
    { token: 'regexp', foreground: c.string },
    { token: 'number', foreground: c.constant },
    { token: 'constant', foreground: c.constant },
    { token: 'attribute.name', foreground: c.constant },
    { token: 'attribute.value', foreground: c.string },
    { token: 'type', foreground: c.variable },
    { token: 'variable', foreground: c.variable },
    { token: 'variable.predefined', foreground: c.constant },
    { token: 'predefined', foreground: c.constant },
    { token: 'function', foreground: c.entity },
    { token: 'tag', foreground: c.tag },
    { token: 'metatag', foreground: c.tag },
    { token: 'delimiter', foreground: c.text },
    { token: 'strong', foreground: c.text, fontStyle: 'bold' },
    { token: 'emphasis', foreground: c.text, fontStyle: 'italic' },
  ];
}

monaco.editor.defineTheme('wfd-light', {
  base: 'vs',
  inherit: true,
  rules: rules(syntax.light),
  colors: {
    'editor.foreground': '#1f2328',
    'editorLineNumber.foreground': '#59636e',
    'diffEditor.insertedLineBackground': '#e6ffec',
    'diffEditor.insertedTextBackground': '#ccffd8',
    'diffEditor.insertedTextBorder': '#1a7f3780',
    'diffEditorGutter.insertedLineBackground': '#ccffd8',
    'diffEditor.removedLineBackground': '#ffebe9',
    'diffEditor.removedTextBackground': '#ffebe9',
    'diffEditor.removedTextBorder': '#cf222e80',
    'diffEditorGutter.removedLineBackground': '#ffd7d5',
  },
});
monaco.editor.defineTheme('wfd-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: rules(syntax.dark),
  colors: {
    'editor.background': '#0d1117',
    'editor.foreground': '#e6edf3',
    'editorGutter.background': '#0d1117',
    'editorLineNumber.foreground': '#9198a1',
    'diffEditor.insertedLineBackground': '#2ea04326',
    'diffEditor.insertedTextBackground': '#2ea0431a',
    'diffEditor.insertedTextBorder': '#3fb95099',
    'diffEditorGutter.insertedLineBackground': '#2ea04326',
    'diffEditor.removedLineBackground': '#f8514926',
    'diffEditor.removedTextBackground': '#f851491a',
    'diffEditor.removedTextBorder': '#f8514999',
    'diffEditorGutter.removedLineBackground': '#f8514926',
  },
});

export const useMonacoTheme = () => (useDarkMode() ? 'wfd-dark' : 'wfd-light');

export { monaco };
