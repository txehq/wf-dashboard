import { DiffEditor } from '@monaco-editor/react';
import { useEffect, useRef } from 'react';
import { languageOf } from '@/lib/language';
import { monaco, useMonacoTheme } from '@/pages/variants-monaco';

// Left: original (read-only); right: result (editable); calls back when the right side changes.
// Models are disposed like SkillDiffEditor: after the DiffEditor is disposed (monaco 0.57)
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
  const theme = useMonacoTheme();
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
      theme={theme}
      keepCurrentOriginalModel
      keepCurrentModifiedModel
      onMount={(editor) => {
        models.current = editor.getModel();
        editor.layout();
        // Scroll the first change into view when it appears (e.g. accepting the first hunk)
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
        // No word completion while editing skill markdown: what you type is what you get
        quickSuggestions: false,
        suggestOnTriggerCharacters: false,
        acceptSuggestionOnEnter: 'off',
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
