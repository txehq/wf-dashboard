import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TaskRecord } from '@wf-dashboard/server/tasks/schema';
import { ArrowLeft, Save } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { fromForm, type TaskForm, toForm } from '@/lib/task-form';
import { saveTask, taskQuery } from '@/lib/tasks';
import { IssuesAlert, TaskFormFields } from '@/pages/tasks-form';

function TaskEditor({ record }: { record: TaskRecord }) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<TaskForm>(() => toForm(record.task));
  const [issues, setIssues] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const saving = useMutation({
    mutationFn: saveTask,
    onSuccess: (saved) => {
      queryClient.setQueryData(taskQuery(saved.task.id).queryKey, saved);
      void queryClient.invalidateQueries({ queryKey: ['tasks'], exact: true });
      setForm(toForm(saved.task));
      setDirty(false);
    },
  });

  const save = () => {
    const result = fromForm(form);
    if (!result.ok) {
      setIssues(result.issues);
      return;
    }
    setIssues([]);
    saving.mutate(result.task);
  };

  const status = saving.isPending
    ? '保存中…'
    : dirty
      ? '有未保存的修改'
      : saving.isSuccess
        ? `已保存到 tasks/${record.task.id}/task.yaml`
        : null;

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
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{record.task.title}</h1>
            <Badge variant="secondary">/{record.task.kind}</Badge>
          </div>
          <p className="font-mono text-xs text-muted-foreground">{record.dir}</p>
        </div>
        <div className="flex items-center gap-3">
          {status && (
            <span className="text-sm text-muted-foreground" data-testid="save-status">
              {status}
            </span>
          )}
          <Button onClick={save} disabled={saving.isPending}>
            <Save />
            保存
          </Button>
        </div>
      </div>
      {issues.length > 0 && <IssuesAlert title="还不能保存" issues={issues} />}
      {saving.isError && (
        <Alert variant="destructive">
          <AlertTitle>保存失败</AlertTitle>
          <AlertDescription>{saving.error.message}</AlertDescription>
        </Alert>
      )}
      <TaskFormFields
        form={form}
        idEditable={false}
        onChange={(next) => {
          setForm(next);
          setDirty(true);
        }}
      />
    </section>
  );
}

export function TaskDetailPage() {
  const { id } = useParams();
  if (id === undefined) throw new Error('路由缺少 task id');
  const task = useQuery(taskQuery(id));
  if (task.isPending) return <p className="text-sm text-muted-foreground">加载中…</p>;
  if (task.isError) {
    return (
      <Alert variant="destructive" className="max-w-xl">
        <AlertTitle>无法读取 task {id}</AlertTitle>
        <AlertDescription>{task.error.message}</AlertDescription>
      </Alert>
    );
  }
  // 切换 task 时重建编辑器，表单从新 task 初始化
  return <TaskEditor key={task.data.task.id} record={task.data} />;
}
