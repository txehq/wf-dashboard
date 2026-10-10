import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Save } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { emptyRubric, fromForm, type TaskForm } from '@/lib/task-form';
import { createTask } from '@/lib/tasks';
import { IssuesAlert, TaskFormFields } from '@/pages/tasks-form';

function blankForm(kind: 'lfg' | 'ic'): TaskForm {
  const common = { id: '', title: '', persona: '', hiddenRequirements: '' };
  if (kind === 'lfg') return { ...common, kind, input: '', rubric: emptyRubric() };
  return {
    ...common,
    kind,
    ticket: { title: '', body: '', acceptanceCriteria: [''] },
    repo: { path: 'repo.bundle', commit: '' },
    hiddenTests: {
      dir: 'hidden-tests',
      config: 'vitest.hidden.config.mjs',
      command:
        'npx vitest run test/hidden --config {configPath} --reporter=junit --outputFile.junit={junitPath}',
      timeoutSeconds: 600,
      manifestYaml: '',
    },
  };
}

export function TaskNewPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<TaskForm>(() => blankForm('lfg'));
  const [issues, setIssues] = useState<string[]>([]);
  const creating = useMutation({
    mutationFn: createTask,
    onSuccess: async (created) => {
      await queryClient.invalidateQueries({ queryKey: ['tasks'], exact: true });
      await navigate(`/tasks/${created.task.id}`);
    },
  });

  const create = () => {
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
          全部 task
        </Link>
      </Button>
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold">新建 task</h1>
          <p className="text-sm text-muted-foreground">
            保存后写入 tasks/&lt;ID&gt;/task.yaml。ic task 的起始仓库 bundle
            与隐藏测试需要放进同一目录。
          </p>
        </div>
        <Button onClick={create} disabled={creating.isPending}>
          <Save />
          {creating.isPending ? '创建中…' : '创建'}
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        <Label>类型</Label>
        <div className="flex gap-2" role="radiogroup" aria-label="类型">
          {(['lfg', 'ic'] as const).map((kind) => (
            <Button
              key={kind}
              role="radio"
              aria-checked={form.kind === kind}
              variant={form.kind === kind ? 'default' : 'outline'}
              onClick={() => {
                if (form.kind !== kind) setForm(blankForm(kind));
              }}
            >
              /{kind}
            </Button>
          ))}
        </div>
      </div>
      {issues.length > 0 && <IssuesAlert title="还不能创建" issues={issues} />}
      {creating.isError && (
        <Alert variant="destructive">
          <AlertTitle>创建失败</AlertTitle>
          <AlertDescription>{creating.error.message}</AlertDescription>
        </Alert>
      )}
      <TaskFormFields form={form} idEditable onChange={setForm} />
    </section>
  );
}
