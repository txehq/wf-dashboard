import { DiffEditor } from '@monaco-editor/react';
import { useEffect, useRef } from 'react';
import { languageOf } from '@/lib/language';
import { monaco, useMonacoTheme } from '@/pages/variants-monaco';

export interface SkillDiffFile {
  path: string;
  oldContent: string;
  newContent: string;
}

// On unmount @monaco-editor/react disposes the models before the DiffEditor, which makes monaco 0.57 throw;
// keep the models instead and dispose them after this commit's unmounts finish and the DiffEditor is disposed
export function SkillDiffEditor({
  file,
  collapseUnchanged = false,
}: {
  file: SkillDiffFile;
  // Collapse unchanged regions, keeping only changes and their context
  collapseUnchanged?: boolean;
}) {
  const theme = useMonacoTheme();
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
      theme={theme}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      onMount={(editor) => {
        models.current = editor.getModel();
        // With monaco already loaded, the DiffEditor is created while its container is still hidden and is only a few
        // pixels wide; the container is visible by onMount, so lay out at the real size first, or the scroll below
        // is computed from line wrapping at that width
        editor.layout();
        // Once the diff is computed, scroll the first change into view
        const subscription = editor.onDidUpdateDiff(() => {
          if ((editor.getLineChanges() ?? []).length === 0) return;
          subscription.dispose();
          editor.revealFirstDiff();
        });
      }}
      options={{
        readOnly: true,
        renderSideBySide: true,
        // Keep two columns even when the page is narrow
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
