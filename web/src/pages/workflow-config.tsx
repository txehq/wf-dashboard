import { Editor } from '@monaco-editor/react';
import { type SmallStage, type WorkflowDefinition } from '@wf-dashboard/server/workflows/schema';
import { GripVertical, Plus, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { DefinitionIssue } from '@/lib/workflow-yaml';
import { monaco, useMonacoTheme } from '@/pages/variants-monaco';

type MonacoEditor = Parameters<NonNullable<Parameters<typeof Editor>[0]['onMount']>>[0];

// "YAML" tab: Monaco edits the same definition; errors show verbatim on their lines
export function DefinitionYamlEditor({
  text,
  readOnly,
  issues,
  onChange,
}: {
  text: string;
  readOnly: boolean;
  issues: DefinitionIssue[];
  onChange: (text: string) => void;
}) {
  const theme = useMonacoTheme();
  const editorRef = useRef<MonacoEditor | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const model = editorRef.current?.getModel();
    if (model === null || model === undefined) return;
    monaco.editor.setModelMarkers(
      model,
      'workflow',
      issues.map((i) => ({
        severity: monaco.MarkerSeverity.Error,
        message: i.message,
        startLineNumber: i.line,
        endLineNumber: i.line,
        startColumn: 1,
        endColumn: model.getLineMaxColumn(i.line),
      })),
    );
  }, [issues, mounted]);
  return (
    <div className="h-96 rounded-lg border" data-testid="workflow-yaml">
      <Editor
        value={text}
        language="yaml"
        theme={theme}
        options={{
          readOnly,
          minimap: { enabled: false },
          fontSize: 13,
          scrollBeyondLastLine: false,
        }}
        onChange={(value) => {
          onChange(value ?? '');
        }}
        onMount={(editor) => {
          editorRef.current = editor;
          setMounted(true);
        }}
      />
    </div>
  );
}

const move = <T,>(list: T[], from: number, to: number): T[] => {
  const next = [...list];
  const [item] = next.splice(from, 1);
  if (item === undefined) return list;
  next.splice(to, 0, item);
  return next;
};

// "Form" tab: name and stages; stages are picked from the skill names of this workflow's variants, reordered by dragging,
// with repeatable and allowInside checkboxes
export function DefinitionForm({
  definition,
  skillNames,
  readOnly,
  onChange,
}: {
  definition: WorkflowDefinition;
  skillNames: string[];
  readOnly: boolean;
  onChange: (definition: WorkflowDefinition) => void;
}) {
  const [dragging, setDragging] = useState<number | null>(null);
  const [adding, setAdding] = useState('');
  const stages = definition.stages;
  const used = new Set(stages.map((s) => s.id));
  const choices = skillNames.filter((n) => !used.has(n) && n !== definition.id);
  const setStages = (next: SmallStage[]) => {
    onChange({ ...definition, stages: next });
  };
  const update = (index: number, change: (stage: SmallStage) => SmallStage) => {
    setStages(stages.map((s, i) => (i === index ? change(s) : s)));
  };
  return (
    <div className="flex flex-col gap-4" data-testid="workflow-form">
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Name</span>
        <input
          className="h-9 max-w-md rounded-md border bg-background px-3"
          value={definition.name}
          disabled={readOnly}
          onChange={(event) => {
            onChange({ ...definition, name: event.target.value });
          }}
        />
      </label>
      <div className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Stages (each name is a skill name; drag to reorder)</span>
        <ol className="flex flex-col gap-1" aria-label="Stages">
          {stages.map((stage, index) => (
            <li
              key={stage.id}
              data-testid={`stage-${stage.id}`}
              draggable={!readOnly}
              onDragStart={() => {
                setDragging(index);
              }}
              onDragOver={(event) => {
                event.preventDefault();
              }}
              onDrop={() => {
                if (dragging !== null && dragging !== index) {
                  setStages(move(stages, dragging, index));
                }
                setDragging(null);
              }}
              className={cn(
                'flex flex-wrap items-center gap-3 rounded-md border px-2 py-1.5',
                dragging === index && 'opacity-50',
              )}
            >
              {!readOnly && <GripVertical className="size-4 cursor-grab text-muted-foreground" />}
              <span className="w-6 text-muted-foreground">{index + 1}</span>
              <span className="min-w-28 font-mono">{stage.id}</span>
              <label className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  checked={stage.repeatable === true}
                  disabled={readOnly}
                  onChange={(event) => {
                    update(index, (s) => {
                      const next = { ...s };
                      if (event.target.checked) next.repeatable = true;
                      else delete next.repeatable;
                      return next;
                    });
                  }}
                />
                repeatable
              </label>
              <span className="flex flex-wrap items-center gap-2 text-muted-foreground">
                allowInside:
                {stages
                  .filter((other) => other.id !== stage.id)
                  .map((other) => (
                    <label key={other.id} className="flex items-center gap-1 text-foreground">
                      <input
                        type="checkbox"
                        aria-label={`Allow ${other.id} inside ${stage.id}`}
                        checked={stage.allowInside?.includes(other.id) === true}
                        disabled={readOnly}
                        onChange={(event) => {
                          update(index, (s) => {
                            const inside = (s.allowInside ?? []).filter((x) => x !== other.id);
                            if (event.target.checked) inside.push(other.id);
                            const next = { ...s };
                            if (inside.length > 0) next.allowInside = inside;
                            else delete next.allowInside;
                            return next;
                          });
                        }}
                      />
                      {other.id}
                    </label>
                  ))}
              </span>
              {!readOnly && (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="ml-auto"
                  aria-label={`Remove stage ${stage.id}`}
                  onClick={() => {
                    // A removed stage also leaves the allowInside of the other stages
                    setStages(
                      stages
                        .filter((_, i) => i !== index)
                        .map((s) => {
                          const inside = s.allowInside?.filter((x) => x !== stage.id);
                          const next = { ...s };
                          if (inside === undefined || inside.length === 0) delete next.allowInside;
                          else next.allowInside = inside;
                          return next;
                        }),
                    );
                  }}
                >
                  <Trash2 />
                </Button>
              )}
            </li>
          ))}
        </ol>
        {!readOnly && (
          <div className="flex items-center gap-2">
            <input
              className="h-9 w-56 rounded-md border bg-background px-3 font-mono"
              aria-label="Stage to add"
              list="stage-suggestions"
              placeholder="Stage id, e.g. scan"
              value={adding}
              onChange={(event) => {
                setAdding(event.target.value.trim());
              }}
            />
            <datalist id="stage-suggestions">
              {choices.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
            <Button
              size="sm"
              variant="outline"
              disabled={adding === '' || used.has(adding) || adding === definition.id}
              onClick={() => {
                setStages([...stages, { id: adding }]);
                setAdding('');
              }}
            >
              <Plus />
              Add stage
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}
