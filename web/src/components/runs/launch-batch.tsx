import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { EnvironmentWarning } from '@/components/environment/environment-warning';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { createBatch, settingsQuery } from '@/lib/runs-api';
import { tasksQuery } from '@/lib/tasks';
import { bigStageIn, workflowsQuery } from '@/lib/workflows-api';
import {
  buildLabel,
  type Variant,
  variantLabel,
  variantOptionsQuery,
  variantsQuery,
} from '@/pages/variants-api';

function isBuilt(v: Variant): boolean {
  return v.buildStatus === 'built' && v.builtHash === v.skillsHash;
}

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

// 发起 batch：已构建的 variant × task × 重复次数；model 与 effort 作用于其中全部 run（Contracts 16.5）
export function LaunchBatch() {
  const client = useQueryClient();
  const variants = useQuery(variantsQuery);
  const tasks = useQuery(tasksQuery);
  const settings = useQuery(settingsQuery);
  const options = useQuery(variantOptionsQuery);
  const workflows = useQuery(workflowsQuery);
  const [variantIds, setVariantIds] = useState<string[]>([]);
  const [taskIds, setTaskIds] = useState<string[]>([]);
  const [repeats, setRepeats] = useState<number | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const launch = useMutation({
    mutationFn: createBatch,
    onSuccess: async () => {
      setVariantIds([]);
      setTaskIds([]);
      await client.invalidateQueries({ queryKey: ['runs'] });
      await client.invalidateQueries({ queryKey: ['variants'] });
    },
  });

  // 默认次数、模型与 effort 来自设置；设置还没有读到（或读取失败）时不能发起，不用别的值代替
  const repeatCount = repeats ?? settings.data?.defaultRepeats ?? null;
  const chosenModel = model ?? settings.data?.agentModel ?? null;
  const chosenEffort = effort ?? settings.data?.agentEffort ?? null;
  const total = variantIds.length * taskIds.length * (repeatCount ?? 0);
  const chosenTasks = (tasks.data ?? []).filter((t) => taskIds.includes(t.task.id));
  const prepares = chosenTasks.flatMap(
    (t) => bigStageIn(workflows.data, t.task.workflow, t.task.bigStage)?.prepare ?? [],
  );
  // task 按 workflow 与大阶段分组
  const taskGroups = [
    ...new Set((tasks.data ?? []).map((t) => `${t.task.workflow}/${t.task.bigStage}`)),
  ].map((key) => ({
    key,
    records: (tasks.data ?? []).filter((t) => `${t.task.workflow}/${t.task.bigStage}` === key),
  }));

  return (
    <Card data-testid="launch-batch">
      <CardHeader>
        <CardTitle>发起评估</CardTitle>
        <CardDescription>每个 variant 在每个 task 上各运行若干次。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-5 lg:grid-cols-[3fr_3fr_1fr]">
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-sm font-medium">variant</legend>
            {variants.isPending && <p className="text-sm text-muted-foreground">加载中…</p>}
            {variants.isError && (
              <p className="text-sm text-destructive">{variants.error.message}</p>
            )}
            {variants.data?.length === 0 && (
              <p className="text-sm text-muted-foreground">
                还没有 variant。
                <Link to="/variants" className="underline">
                  去 Variants 页面导入基线
                </Link>
              </p>
            )}
            {variants.data?.map((v) => {
              const built = isBuilt(v);
              return (
                <div key={v.id} className="flex items-center gap-2 text-sm">
                  <label className="flex min-w-0 items-center gap-2">
                    <input
                      type="checkbox"
                      checked={variantIds.includes(v.id)}
                      disabled={!built}
                      onChange={() => {
                        setVariantIds(toggle(variantIds, v.id));
                      }}
                    />
                    <span className={built ? 'truncate' : 'truncate text-muted-foreground'}>
                      {variantLabel(v)}
                    </span>
                  </label>
                  {!built && v.installDir === null && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      导入的历史记录，不能运行
                    </span>
                  )}
                  {!built && v.installDir !== null && (
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {buildLabel(v)} ·{' '}
                      <Link to={`/variants/${v.id}`} className="underline">
                        去构建
                      </Link>
                    </span>
                  )}
                </div>
              );
            })}
          </fieldset>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">task</legend>
            {tasks.isPending && <p className="text-sm text-muted-foreground">加载中…</p>}
            {tasks.isError && <p className="text-sm text-destructive">{tasks.error.message}</p>}
            {taskGroups.map(({ key, records }) => (
              <div key={key} className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{key}</span>
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
              <span className="font-medium">重复次数</span>
              {repeatCount === null ? (
                settings.isError ? (
                  <span role="alert" className="text-destructive" data-testid="repeats-error">
                    读取默认次数失败：{settings.error.message}
                  </span>
                ) : (
                  <span className="text-muted-foreground">加载中…</span>
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
              <span className="font-medium">model</span>
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
                    {m.alias}（{m.model}）
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5 text-sm">
              <span className="font-medium">effort</span>
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
                读取模型列表失败：{options.error.message}
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
                throw new Error('还没有重复次数、model 或 effort');
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
            {launch.isPending ? '正在建立…' : `发起 ${String(total)} 个 run`}
          </Button>
          <div
            className="flex flex-col gap-0.5 text-xs text-muted-foreground"
            data-testid="launch-summary"
          >
            <span>
              {variantIds.length} 个 variant × {taskIds.length} 个 task × {repeatCount ?? '?'} 次 ={' '}
              {total} 个 run（{chosenModel ?? '?'} · {chosenEffort ?? '?'}）；选中的 variant
              将被冻结，之后不能再编辑。
            </span>
            {prepares.includes('empty-repo') && <span>每个 run 会在 txehq 建一个空仓库。</span>}
            {prepares.includes('vault-dir') && (
              <span>每个 run 会写入 vault 的 Project Magi Eval。</span>
            )}
            {prepares.includes('repo-copy') && <span>每个 run 会在 txehq 建起始仓库的副本。</span>}
            {prepares.includes('ticket-copy') && (
              <span>每个 run 会在 Linear Workflow Eval 建工单。</span>
            )}
          </div>
          <EnvironmentWarning />
        </div>
        {launch.isError && (
          <p role="alert" className="text-sm text-destructive">
            发起失败：{launch.error.message}
          </p>
        )}
        {launch.isSuccess && (
          <p className="text-sm" data-testid="launch-done">
            已建 batch <span className="font-mono">{launch.data.id}</span>，共{' '}
            {launch.data.runList.length} 个 run，已加入队列。
          </p>
        )}
      </CardContent>
    </Card>
  );
}
