import { DiffEditor } from '@monaco-editor/react';
import { useEffect, useRef } from 'react';
import { languageOf } from '@/lib/language';
import { monaco } from '@/pages/variants-monaco';

export interface SkillDiffFile {
  path: string;
  oldContent: string;
  newContent: string;
}

// @monaco-editor/react 卸载时先释放 model 再释放 DiffEditor，monaco 0.57 会因此报错；
// 改为保留 model，等这次提交里的卸载全部完成、DiffEditor 已释放后再释放 model
export function SkillDiffEditor({ file }: { file: SkillDiffFile }) {
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
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      onMount={(editor) => {
        models.current = editor.getModel();
        // diff 算完后把第一处改动滚动到视野中
        const subscription = editor.onDidUpdateDiff(() => {
          const first = editor.getLineChanges()?.[0];
          if (first === undefined) return;
          subscription.dispose();
          const line = Math.max(first.modifiedStartLineNumber, 1);
          editor.getModifiedEditor().revealLineInCenter(line);
        });
      }}
      options={{
        readOnly: true,
        renderSideBySide: true,
        // 页面宽度有限时也保持左右两栏
        useInlineViewWhenSpaceIsLimited: false,
        minimap: { enabled: false },
        wordWrap: 'on',
        fontSize: 13,
        scrollBeyondLastLine: false,
      }}
    />
  );
}
