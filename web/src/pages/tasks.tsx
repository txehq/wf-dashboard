import { useQuery } from '@tanstack/react-query';
import { rubricMaxScore, type TaskRecord } from '@wf-dashboard/server/tasks/schema';
import { Plus } from 'lucide-react';
import { Link } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { tasksQuery } from '@/lib/tasks';

function summary({ task }: TaskRecord) {
  return task.input ?? task.ticket?.title ?? '';
}

function measure({ task }: TaskRecord) {
  if (task.rubric !== undefined) {
    return `${String(task.rubric.flatMap((g) => g.items).length)} 条 · 满分 ${String(rubricMaxScore(task.rubric))}`;
  }
  if (task.hiddenTests !== undefined) {
    return `${String(Object.values(task.hiddenTests.manifest).flat().length)} 个隐藏测试`;
  }
  return `${String(task.ticket?.acceptanceCriteria.length ?? 0)} 条验收标准`;
}

// dev-workflow 两个大阶段的说明；其他 workflow 的大阶段只显示 workflow 名
const descriptions: Record<string, string> = {
  'dev-workflow/lfg': '输入一个想法，模拟用户按隐藏需求回答，按 rubric 给四个产物打分。',
  'dev-workflow/ic':
    '一张工单加固定 commit 的起始仓库，按隐藏测试的通过率评分；没有隐藏测试时按验收标准逐条评分。',
};

// task 按 workflow 与大阶段分组（Contracts 16.3），dev-workflow 在前
function groupsOf(records: TaskRecord[]) {
  const keys = [
    'dev-workflow/lfg',
    'dev-workflow/ic',
    ...records.map((r) => `${r.task.workflow}/${r.task.bigStage}`),
  ];
  return [...new Set(keys)].map((key) => {
    const [workflow = '', bigStage = ''] = key.split('/');
    return {
      key,
      workflow,
      bigStage,
      records: records.filter((r) => r.task.workflow === workflow && r.task.bigStage === bigStage),
    };
  });
}

function TaskGroup({
  title,
  description,
  summaryLabel,
  measureLabel,
  records,
}: {
  title: string;
  description: string;
  summaryLabel: string;
  measureLabel: string;
  records: TaskRecord[];
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        {records.length === 0 ? (
          <p className="text-sm text-muted-foreground">还没有 task。</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>标题</TableHead>
                <TableHead>{summaryLabel}</TableHead>
                <TableHead>{measureLabel}</TableHead>
                <TableHead>ID</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.map((record) => (
                <TableRow key={record.task.id}>
                  <TableCell className="font-medium">
                    <Link to={`/tasks/${record.task.id}`} className="hover:underline">
                      {record.task.title}
                    </Link>
                  </TableCell>
                  <TableCell className="max-w-md truncate">{summary(record)}</TableCell>
                  <TableCell>{measure(record)}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {record.task.id}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function TasksPage() {
  const tasks = useQuery(tasksQuery);
  return (
    <section className="flex flex-col gap-6">
      <div className="flex items-start justify-between">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold">Tasks</h1>
          <p className="text-sm text-muted-foreground">评估用的 task 与 rubric。</p>
        </div>
        <Button asChild>
          <Link to="/tasks/new">
            <Plus />
            新建 task
          </Link>
        </Button>
      </div>
      {tasks.isPending && <p className="text-sm text-muted-foreground">加载中…</p>}
      {tasks.isError && (
        <Alert variant="destructive">
          <AlertTitle>无法读取 task 列表</AlertTitle>
          <AlertDescription>{tasks.error.message}</AlertDescription>
        </Alert>
      )}
      {tasks.isSuccess &&
        groupsOf(tasks.data).map((group) => (
          <TaskGroup
            key={group.key}
            title={
              group.workflow === 'dev-workflow'
                ? `/${group.bigStage}`
                : `/${group.bigStage} (${group.workflow})`
            }
            description={descriptions[group.key] ?? `workflow ${group.workflow} 的大阶段`}
            summaryLabel={group.bigStage === 'ic' ? '工单' : '输入'}
            measureLabel={group.bigStage === 'ic' ? '评分依据' : 'Rubric'}
            records={group.records}
          />
        ))}
    </section>
  );
}
