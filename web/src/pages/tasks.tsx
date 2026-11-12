import { useQuery } from '@tanstack/react-query';
import { rubricMaxScore, type TaskRecord } from '@wf-dashboard/server/tasks/schema';
import { type EvalKind, evalKinds } from '@wf-dashboard/server/workflows/schema';
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
import { formatNoun } from '@/lib/format';
import { tasksQuery } from '@/lib/tasks';

function summary({ task }: TaskRecord) {
  return task.input ?? task.ticket?.title ?? '';
}

function measure({ task }: TaskRecord) {
  if (task.rubric !== undefined) {
    return `${formatNoun(task.rubric.flatMap((g) => g.items).length, 'item')} · max ${String(rubricMaxScore(task.rubric))}`;
  }
  if (task.hiddenTests !== undefined) {
    return formatNoun(Object.values(task.hiddenTests.manifest).flat().length, 'hidden test');
  }
  const criteria = task.ticket?.acceptanceCriteria.length ?? 0;
  return `${String(criteria)} acceptance ${criteria === 1 ? 'criterion' : 'criteria'}`;
}

// What the two evaluation kinds measure (Contracts 16.2)
const descriptions: Record<EvalKind, string> = {
  lfg: 'Give an idea; the simulated user answers from hidden requirements, and a rubric scores the four outputs.',
  ic: 'A ticket plus a starting repo at a fixed commit, scored by the hidden test pass rate, or per acceptance criterion when there are no hidden tests.',
};

// Tasks grouped by evaluation kind (Contracts 16.3), lfg first
function groupsOf(records: TaskRecord[]) {
  return evalKinds.map((kind) => ({
    kind,
    records: records.filter((r) => r.task.kind === kind),
  }));
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
          <p className="text-sm text-muted-foreground">No tasks yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Title</TableHead>
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
          <p className="text-sm text-muted-foreground">Tasks and rubrics for evaluation.</p>
        </div>
        <Button asChild>
          <Link to="/tasks/new">
            <Plus />
            New task
          </Link>
        </Button>
      </div>
      {tasks.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {tasks.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load tasks</AlertTitle>
          <AlertDescription>{tasks.error.message}</AlertDescription>
        </Alert>
      )}
      {tasks.isSuccess &&
        groupsOf(tasks.data).map((group) => (
          <TaskGroup
            key={group.kind}
            title={`/${group.kind}`}
            description={descriptions[group.kind]}
            summaryLabel={group.kind === 'ic' ? 'Ticket' : 'Input'}
            measureLabel={group.kind === 'ic' ? 'Graded by' : 'Rubric'}
            records={group.records}
          />
        ))}
    </section>
  );
}
