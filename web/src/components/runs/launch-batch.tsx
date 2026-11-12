import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { EVAL_KINDS } from '@wf-dashboard/server/workflows/eval-kinds';
import { evalKinds } from '@wf-dashboard/server/workflows/schema';
import { Play } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { EnvironmentWarning } from '@/components/environment/environment-warning';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { formatNoun } from '@/lib/format';
import { createBatch, settingsQuery } from '@/lib/runs-api';
import { tasksQuery } from '@/lib/tasks';
import { defaultBatchVariants, evalKindOf, workflowsQuery } from '@/lib/workflows-api';
import {
  buildLabel,
  isBuilt,
  variantHref,
  variantLabel,
  variantOptionsQuery,
  variantsQuery,
} from '@/pages/variants-api';
import { ReleaseBadge } from '@/pages/workflows';

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

// Start a batch: built variants x tasks x repeats; model and effort apply to every run in it (Contracts 16.5)
export function LaunchBatch() {
  const client = useQueryClient();
  const variants = useQuery(variantsQuery);
  const tasks = useQuery(tasksQuery);
  const settings = useQuery(settingsQuery);
  const options = useQuery(variantOptionsQuery);
  const workflows = useQuery(workflowsQuery);
  // null until the user ticks something: use the default variants
  const [pickedVariants, setPickedVariants] = useState<string[] | null>(null);
  const [taskIds, setTaskIds] = useState<string[]>([]);
  const [repeats, setRepeats] = useState<number | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const launch = useMutation({
    mutationFn: createBatch,
    onSuccess: async () => {
      setPickedVariants(null);
      setTaskIds([]);
      await client.invalidateQueries({ queryKey: ['runs'] });
      await client.invalidateQueries({ queryKey: ['variants'] });
    },
  });

  // Default repeats, model and effort come from Settings; until Settings load (or if they fail) the batch cannot start, and no other value stands in
  const repeatCount = repeats ?? settings.data?.defaultRepeats ?? null;
  const chosenModel = model ?? settings.data?.agentModel ?? null;
  const chosenEffort = effort ?? settings.data?.agentEffort ?? null;
  const chosenTasks = (tasks.data ?? []).filter((t) => taskIds.includes(t.task.id));
  const defaultVariants = defaultBatchVariants(
    workflows.data,
    variants.data,
    chosenTasks.map((t) => t.task.kind),
  );
  const variantIds = pickedVariants ?? defaultVariants;
  const total = variantIds.length * taskIds.length * (repeatCount ?? 0);
  const prepares = chosenTasks.flatMap((t) => EVAL_KINDS[t.task.kind].prepare);
  // Tasks grouped by evaluation kind (Contracts 16.3)
  const taskGroups = evalKinds.map((kind) => ({
    kind,
    records: (tasks.data ?? []).filter((t) => t.task.kind === kind),
  }));
  // Only variants of evaluation workflows can start runs (Contracts 16.1)
  const evaluable = (variants.data ?? []).filter(
    (v) => evalKindOf(workflows.data, v.workflowId) !== null,
  );

  return (
    <Card data-testid="launch-batch">
      <CardHeader>
        <CardTitle>Start evaluation</CardTitle>
        <CardDescription>Each variant runs on each task a set number of times.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-5 lg:grid-cols-[3fr_3fr_1fr]">
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-sm font-medium">Variant</legend>
            {variants.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
            {variants.isError && (
              <p className="text-sm text-destructive">{variants.error.message}</p>
            )}
            {variants.data?.length === 0 && (
              <p className="text-sm text-muted-foreground">
                No variants yet.{' '}
                <Link to="/workflows" className="underline">
                  Import a baseline on the Workflows page
                </Link>
              </p>
            )}
            {evaluable.map((v) => {
              const built = isBuilt(v);
              const kind = evalKindOf(workflows.data, v.workflowId);
              return (
                <div key={v.id} className="flex items-center gap-2 text-sm">
                  <label className="flex min-w-0 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={variantIds.includes(v.id)}
                      disabled={!built}
                      onChange={() => {
                        setPickedVariants(toggle(variantIds, v.id));
                      }}
                    />
                    <span className={built ? 'truncate' : 'truncate text-muted-foreground'}>
                      {variantLabel(v)}
                    </span>
                    <ReleaseBadge
                      variant={v}
                      latestTag={
                        workflows.data?.find((w) => w.id === v.workflowId)?.release?.tag ?? null
                      }
                    />
                    {kind !== v.workflowId && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        Evaluates {kind}
                      </span>
                    )}
                  </label>
                  {!built && v.installDir === null && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      Imported history, cannot run
                    </span>
                  )}
                  {!built && v.installDir !== null && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {buildLabel(v)} ·{' '}
                      <Link to={variantHref(v)} className="underline">
                        Build it
                      </Link>
                    </span>
                  )}
                </div>
              );
            })}
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Task</legend>
            {tasks.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
            {tasks.isError && <p className="text-sm text-destructive">{tasks.error.message}</p>}
            {taskGroups.map(({ kind, records }) => (
              <div key={kind} className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">/{kind}</span>
                {records.map((t) => (
                  <label key={t.task.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={taskIds.includes(t.task.id)}
                      onChange={() => {
                        setTaskIds(toggle(taskIds, t.task.id));
                      }}
                    />
                    {t.task.title}
                  </label>
                ))}
              </div>
            ))}
          </fieldset>
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Repeats</span>
              {repeatCount === null ? (
                settings.isError ? (
                  <span role="alert" className="text-destructive" data-testid="repeats-error">
                    Could not load the default repeats: {settings.error.message}
                  </span>
                ) : (
                  <span className="text-muted-foreground">Loading…</span>
                )
              ) : (
                <Input
                  type="number"
                  min={1}
                  max={50}
                  value={repeatCount}
                  className="w-24"
                  onChange={(event) => {
                    setRepeats(Number(event.target.value));
                  }}
                />
              )}
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Model</span>
              <select
                className="h-9 rounded-md border bg-background px-2"
                data-testid="launch-model"
                value={chosenModel ?? ''}
                disabled={chosenModel === null || options.data === undefined}
                onChange={(event) => {
                  setModel(event.target.value);
                }}
              >
                {options.data?.models.map((m) => (
                  <option key={m.alias} value={m.alias}>
                    {m.alias} ({m.model})
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">Effort</span>
              <select
                className="h-9 rounded-md border bg-background px-2"
                data-testid="launch-effort"
                value={chosenEffort ?? ''}
                disabled={chosenEffort === null || options.data === undefined}
                onChange={(event) => {
                  setEffort(event.target.value);
                }}
              >
                {options.data?.efforts.map((e) => (
                  <option key={e} value={e}>
                    {e}
                  </option>
                ))}
              </select>
            </label>
            {options.isError && (
              <span role="alert" className="text-sm text-destructive">
                Could not load the model list: {options.error.message}
              </span>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4 border-t pt-4">
          <Button
            disabled={
              repeatCount === null ||
              chosenModel === null ||
              chosenEffort === null ||
              total === 0 ||
              launch.isPending
            }
            onClick={() => {
              if (repeatCount === null || chosenModel === null || chosenEffort === null) {
                throw new Error('Repeats, model or effort is not set yet');
              }
              launch.mutate({
                variantIds,
                taskIds,
                repeats: repeatCount,
                model: chosenModel,
                effort: chosenEffort,
              });
            }}
          >
            <Play />
            {launch.isPending ? 'Creating…' : `Start ${formatNoun(total, 'run')}`}
          </Button>
          <div
            className="flex flex-col gap-0.5 text-xs text-muted-foreground"
            data-testid="launch-summary"
          >
            <span>
              {formatNoun(variantIds.length, 'variant')} × {formatNoun(taskIds.length, 'task')} ×{' '}
              {repeatCount ?? '?'} = {formatNoun(total, 'run')} ({chosenModel ?? '?'} ·{' '}
              {chosenEffort ?? '?'}). The selected variants are frozen and can no longer be edited.
            </span>
            {prepares.includes('empty-repo') && (
              <span>Each run creates an empty repo in txehq.</span>
            )}
            {prepares.includes('vault-dir') && (
              <span>Each run writes to Project Magi Eval in the vault.</span>
            )}
            {prepares.includes('repo-copy') && (
              <span>Each run creates a copy of the starting repo in txehq.</span>
            )}
            {prepares.includes('ticket-copy') && (
              <span>Each run creates a ticket in Linear Workflow Eval.</span>
            )}
          </div>
          <EnvironmentWarning />
        </div>
        {launch.isError && (
          <p role="alert" className="text-sm text-destructive">
            Could not start: {launch.error.message}
          </p>
        )}
        {launch.isSuccess && (
          <p className="text-sm" data-testid="launch-done">
            Created batch <span className="font-mono">{launch.data.id}</span> with{' '}
            {formatNoun(launch.data.runList.length, 'run')}, now queued.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
