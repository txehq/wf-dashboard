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

// 新建 task 先选评测类型 lfg 或 ic（Contracts 16.3）
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
  { mode: 'ic', label: '/ic 手写工单' },
  { mode: 'ic-linear', label: '/ic 从 Linear 导入' },
];

export function TaskNewPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<Mode>('lfg');
  const [form, setForm] = useState<TaskForm | null>(() => blankForm('lfg'));
  // 导入预览中的 workflow 分析，显示在表单的"起始仓库与 checks"中
  const [analysis, setAnalysis] = useState<WorkflowAnalysis | null>(null);
  // 每次采纳导入的内容都重建表单
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
          全部 task
        </Link>
      </Button>
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold">新建 task</h1>
          <p className="text-sm text-muted-foreground">
            保存后写入 tasks/&lt;ID&gt;/task.yaml。手写的 ic task 的起始仓库 bundle
            与隐藏测试需要放进同一目录；从 Linear 导入的 task 在保存时生成 bundle。
          </p>
        </div>
        <Button onClick={create} disabled={form === null || creating.isPending}>
          <Save />
          {creating.isPending ? '创建中…' : '创建'}
        </Button>
      </div>
      <div className="flex flex-col gap-2">
        <Label>类型</Label>
        <div className="flex gap-2" role="radiogroup" aria-label="类型">
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
      {issues.length > 0 && <IssuesAlert title="还不能创建" issues={issues} />}
      {creating.isError && (
        <Alert variant="destructive">
          <AlertTitle>创建失败</AlertTitle>
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
