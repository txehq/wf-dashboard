import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { ImportPreview, WorkflowAnalysis } from '@wf-dashboard/server/tasks/import-schema';
import { ArrowLeft, Save } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  blankHiddenTests,
  emptyRubric,
  fromForm,
  icFormFromDraft,
  type TaskForm,
} from '@/lib/task-form';
import { createTask } from '@/lib/tasks';
import { IssuesAlert, TaskFormFields } from '@/pages/tasks-form';
import { LinearImportPanel } from '@/pages/tasks-import';

// A new task starts by choosing the evaluation kind, lfg or ic (Contracts 16.3)
function blankForm(kind: 'lfg' | 'ic'): TaskForm {
  const common = {
    id: '',
    title: '',
    persona: '',
    hiddenRequirements: '',
  };
  if (kind === 'lfg') return { ...common, kind, input: '', rubric: emptyRubric() };
  return {
    ...common,
    kind,
    ticket: { title: '', body: '', acceptanceCriteria: [''] },
    repo: { path: 'repo.bundle', commit: '' },
    requiredChecks: ['ci'],
    hasHiddenTests: true,
    hiddenTests: blankHiddenTests(),
  };
}

type Mode = 'lfg' | 'ic' | 'ic-linear';

const modes: { mode: Mode; label: string }[] = [
  { mode: 'lfg', label: '/lfg' },
  { mode: 'ic', label: '/ic, write a ticket' },
  { mode: 'ic-linear', label: '/ic, import from Linear' },
];

export function TaskNewPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('lfg');
  const [form, setForm] = useState<TaskForm | null>(() => blankForm('lfg'));
  // Workflow analysis from the import preview, shown in the form's "Starting repo and checks"
  const [analysis, setAnalysis] = useState<WorkflowAnalysis | null>(null);
  // Each adoption of imported content rebuilds the form
  const [adopted, setAdopted] = useState(0);
  const [issues, setIssues] = useState<string[]>([]);
  const creating = useMutation({
    mutationFn: createTask,
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['tasks'], exact: true });
      await navigate(`/tasks/${created.task.id}`);
    },
  });

  const choose = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    setIssues([]);
    setAnalysis(null);
    setForm(next === 'ic-linear' ? null : blankForm(next));
  };

  const adopt = (preview: ImportPreview) => {
    setAnalysis(preview.workflows);
    setForm(icFormFromDraft(preview.task));
    setAdopted((n) => n + 1);
  };

  const create = () => {
    if (form === null) return;
    const result = fromForm(form);
    if (!result.ok) {
      setIssues(result.issues);
      return;
    }
    setIssues([]);
    creating.mutate(result.task);
  };

  return (
    <section className="flex max-w-5xl flex-col gap-6">
      <Button asChild variant="ghost" className="w-fit">
        <Link to="/tasks">
          <ArrowLeft />
          All tasks
        </Link>
      </Button>
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold">New task</h1>
          <p className="text-sm text-muted-foreground">
            Saved to tasks/&lt;ID&gt;/task.yaml. A hand-written ic task needs its starting repo
            bundle and hidden tests in the same folder; a task imported from Linear gets its bundle
            when saved.
          </p>
        </div>
        <Button onClick={create} disabled={form === null || creating.isPending}>
          <Save />
          {creating.isPending ? 'Creating…' : 'Create'}
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        <Label>Kind</Label>
        <div className="flex gap-2" role="radiogroup" aria-label="Kind">
          {modes.map(({ mode: m, label }) => (
            <Button
              key={m}
              role="radio"
              aria-checked={mode === m}
              variant={mode === m ? 'default' : 'outline'}
              onClick={() => {
                choose(m);
              }}
            >
              {label}
            </Button>
          ))}
        </div>
      </div>
      {mode === 'ic-linear' && <LinearImportPanel onAdopt={adopt} />}
      {issues.length > 0 && <IssuesAlert title="Cannot create yet" issues={issues} />}
      {creating.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not create</AlertTitle>
          <AlertDescription>{creating.error.message}</AlertDescription>
        </Alert>
      )}
      {form !== null && (
        <TaskFormFields
          key={`${mode}-${String(adopted)}`}
          form={form}
          idEditable
          analysis={analysis}
          onChange={setForm}
        />
      )}
    </section>
  );
}
