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
import { buildLabel, type Variant, variantsQuery } from '@/pages/variants-api';

function isBuilt(v: Variant): boolean {
  return v.buildStatus === 'built' && v.builtHash === v.skillsHash;
}

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

// 发起 batch：已构建的 variant × task × 重复次数
export function LaunchBatch() {
  const client = useQueryClient();
  const variants = useQuery(variantsQuery);
  const tasks = useQuery(tasksQuery);
  const settings = useQuery(settingsQuery);
  const [variantIds, setVariantIds] = useState<string[]>([]);
  const [taskIds, setTaskIds] = useState<string[]>([]);
  const [repeats, setRepeats] = useState<number | null>(null);
  const launch = useMutation({
    mutationFn: createBatch,
    onSuccess: async () => {
      setVariantIds([]);
      setTaskIds([]);
      await client.invalidateQueries({ queryKey: ['runs'] });
      await client.invalidateQueries({ queryKey: ['variants'] });
    },
  });

  const repeatCount = repeats ?? settings.data?.defaultRepeats ?? 1;
  const total = variantIds.length * taskIds.length * repeatCount;
  const chosenTasks = (tasks.data ?? []).filter((t) => taskIds.includes(t.task.id));
  const hasLfg = chosenTasks.some((t) => t.task.kind === 'lfg');
  const hasIc = chosenTasks.some((t) => t.task.kind === 'ic');

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
                      {v.name}
                    </span>
                    <span className="shrink-0 font-mono text-xs text-muted-foreground">
                      {v.model} · {v.effort}
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
            {(['lfg', 'ic'] as const).map((kind) => {
              const group = (tasks.data ?? []).filter((t) => t.task.kind === kind);
              if (group.length === 0) return null;
              return (
                <div key={kind} className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">/{kind}</span>
                  {group.map((t) => (
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
              );
            })}
          </fieldset>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">重复次数</span>
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
          </label>
        </div>
        <div className="flex flex-wrap items-center gap-4 border-t pt-4">
          <Button
            disabled={total === 0 || launch.isPending}
            onClick={() => {
              launch.mutate({ variantIds, taskIds, repeats: repeatCount });
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
              {variantIds.length} 个 variant × {taskIds.length} 个 task × {repeatCount} 次 = {total}{' '}
              个 run；选中的 variant 将被冻结，之后不能再编辑。
            </span>
            {hasLfg && (
              <span>
                /lfg 的每个 run 会在 txehq 建一个空仓库，并写入 vault 的 Project Magi Eval。
              </span>
            )}
            {hasIc && (
              <span>
                /ic 的每个 run 会在 txehq 建起始仓库的副本，并在 Linear Workflow Eval 建工单。
              </span>
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
