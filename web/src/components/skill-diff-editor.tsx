import { DiffEditor } from '@monaco-editor/react';
import { useEffect, useRef } from 'react';
import { languageOf } from '@/lib/language';
import { MONACO_THEME, monaco } from '@/pages/variants-monaco';

export interface SkillDiffFile {
  path: string;
  oldContent: string;
  newContent: string;
}

// @monaco-editor/react 卸载时先释放 model 再释放 DiffEditor，monaco 0.57 会因此报错；
// 改为保留 model，等这次提交里的卸载全部完成、DiffEditor 已释放后再释放 model
export function SkillDiffEditor({
  file,
  collapseUnchanged = false,
}: {
  file: SkillDiffFile;
  // 折叠未改动的段落，只留改动及其上下文
  collapseUnchanged?: boolean;
}) {
  const models = useRef<monaco.editor.IDiffEditorModel | null>(null);
  useEffect(
    () => () => {
      const current = models.current;
      setTimeout(() => {
        current?.original.dispose();
        current?.modified.dispose();
      });
    },
    [],
  );
  return (
    <DiffEditor
      original={file.oldContent}
      modified={file.newContent}
      language={languageOf(file.path)}
      theme={MONACO_THEME}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      onMount={(editor) => {
        models.current = editor.getModel();
        // 已加载 monaco 时 DiffEditor 在容器仍隐藏时创建，宽度只有几像素；
        // onMount 时容器已显示，先按实际尺寸布局，否则下面的滚动按几像素宽的折行计算
        editor.layout();
        // diff 算完后把第一处改动滚动到视野中
        const subscription = editor.onDidUpdateDiff(() => {
          if ((editor.getLineChanges() ?? []).length === 0) return;
          subscription.dispose();
          editor.revealFirstDiff();
        });
      }}
      options={{
        readOnly: true,
        renderSideBySide: true,
        // 页面宽度有限时也保持左右两栏
        useInlineViewWhenSpaceIsLimited: false,
        hideUnchangedRegions: { enabled: collapseUnchanged, contextLineCount: 4 },
        minimap: { enabled: false },
        wordWrap: 'on',
        fontSize: 13,
        scrollBeyondLastLine: false,
      }}
    />
  );
}
