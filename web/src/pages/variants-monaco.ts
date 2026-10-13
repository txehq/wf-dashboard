import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';

// 使用本地打包的 monaco，不从 CDN 加载
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

// 对比视图的颜色与共用的 diff 显示相同（Contracts 21.3，GitHub 的红与绿）：整行的底色、行内改动的词、行号栏。
// Monaco 的主题是全局的，页面上所有编辑器都用这一个
export const MONACO_THEME = 'wfd-light';
monaco.editor.defineTheme(MONACO_THEME, {
  base: 'vs',
  inherit: true,
  rules: [],
  colors: {
    'diffEditor.insertedLineBackground': '#e6ffec',
    'diffEditor.insertedTextBackground': '#abf2bc',
    'diffEditorGutter.insertedLineBackground': '#ccffd8',
    'diffEditor.removedLineBackground': '#ffebe9',
    'diffEditor.removedTextBackground': '#ff818266',
    'diffEditorGutter.removedLineBackground': '#ffd7d5',
  },
});

export { monaco };
