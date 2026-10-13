import { loader } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/editor/editor.worker?worker';
import { useDarkMode } from '@/lib/dark-mode';

// 使用本地打包的 monaco，不从 CDN 加载
self.MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });

// 对比视图的颜色与共用的 diff 显示相同（Contracts 21.3，GitHub 的红与绿，见 components/diff/colors.css）：
// 整行的底色、行内改动的词、行号栏，明暗各一个主题。Monaco 的主题是全局的，页面上所有编辑器随页面的主题切换
monaco.editor.defineTheme('wfd-light', {
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
monaco.editor.defineTheme('wfd-dark', {
  base: 'vs-dark',
  inherit: true,
  rules: [],
  colors: {
    'diffEditor.insertedLineBackground': '#2ea04326',
    'diffEditor.insertedTextBackground': '#2ea04366',
    'diffEditorGutter.insertedLineBackground': '#3fb9504d',
    'diffEditor.removedLineBackground': '#f8514926',
    'diffEditor.removedTextBackground': '#f8514966',
    'diffEditorGutter.removedLineBackground': '#f851494d',
  },
});

export const useMonacoTheme = () => (useDarkMode() ? 'wfd-dark' : 'wfd-light');

export { monaco };
