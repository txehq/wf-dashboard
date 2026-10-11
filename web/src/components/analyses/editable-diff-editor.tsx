import { DiffEditor } from '@monaco-editor/react';
import { useEffect, useRef } from 'react';
import { languageOf } from '@/lib/language';
import { monaco } from '@/pages/variants-monaco';

// 左侧为原文（只读），右侧为结果（可编辑）；右侧内容变化时回调。
// model 的释放方式与 SkillDiffEditor 相同：等 DiffEditor 释放后再释放 model（monaco 0.57）
export function EditableDiffEditor({
  path,
  original,
  modified,
  onChange,
}: {
  path: string;
  original: string;
  modified: string;
  onChange: (value: string) => void;
}) {
  const models = useRef<monaco.editor.IDiffEditorModel | null>(null);
  const latest = useRef(onChange);
  useEffect(() => {
    latest.current = onChange;
  });
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
      original={original}
      modified={modified}
      language={languageOf(path)}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      onMount={(editor) => {
        models.current = editor.getModel();
        editor.layout();
        // 第一次出现改动（例如接受第一处修改）时把它滚动到视野中
        const subscription = editor.onDidUpdateDiff(() => {
          if ((editor.getLineChanges() ?? []).length === 0) return;
          subscription.dispose();
          editor.revealFirstDiff();
        });
        const modifiedEditor = editor.getModifiedEditor();
        modifiedEditor.onDidChangeModelContent(() => {
          latest.current(modifiedEditor.getValue());
        });
      }}
      options={{
        readOnly: false,
        originalEditable: false,
        renderSideBySide: true,
        useInlineViewWhenSpaceIsLimited: false,
        minimap: { enabled: false },
        wordWrap: 'on',
        fontSize: 13,
        scrollBeyondLastLine: false,
      }}
    />
  );
}
