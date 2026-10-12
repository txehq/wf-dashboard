import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { DriverChoice } from '@/components/live/resume-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { createLive, isBuiltVariant, type LiveDetail, type LiveDriver } from '@/lib/live-api';
import { tasksQuery } from '@/lib/tasks';
import { variantLabel, variantsQuery } from '@/pages/variants-api';

type Workflow = 'lfg' | 'ic';
type Environment = 'isolated' | 'real';
const ONSITE = '';

// "另存为 task"：lfg 带上想法打开新建表单，ic 带上工单地址打开第 13 节的导入表单
function saveAsTaskHref(workflow: Workflow, input: string): string {
  const params =
    workflow === 'lfg'
      ? new URLSearchParams({ mode: 'lfg', input })
      : new URLSearchParams({ mode: 'ic-linear', issue: input });
  return `/tasks/new?${params.toString()}`;
}

// 新建交互（Contracts 14.2）
export function NewLiveForm({ onCreated }: { onCreated: (live: LiveDetail) => void }) {
  const client = useQueryClient();
  const variants = useQuery(variantsQuery);
  const tasks = useQuery(tasksQuery);
  const [workflow, setWorkflow] = useState<Workflow>('lfg');
  const [taskId, setTaskId] = useState<string>(ONSITE);
  const [input, setInput] = useState('');
  const [variantId, setVariantId] = useState<string | null>(null);
  const [environment, setEnvironment] = useState<Environment>('isolated');
  const [cwd, setCwd] = useState('');
  const [driver, setDriver] = useState<LiveDriver>('human');
  const creating = useMutation({
    mutationFn: createLive,
    onSuccess: async (live) => {
      setInput('');
      await client.invalidateQueries({ queryKey: ['live'] });
      onCreated(live);
    },
  });

  const built = (variants.data ?? []).filter(isBuiltVariant);
  const chosenVariant = variantId ?? built[0]?.id ?? null;
  // 交互只接受 dev-workflow 的 task（可配置的大阶段由 W37 接入）
  const ofKind = (tasks.data ?? []).filter(
    (t) => t.task.workflow === 'dev-workflow' && t.task.bigStage === workflow,
  );
  const onsite = taskId === ONSITE;
  const ready =
    chosenVariant !== null &&
    (!onsite || input.trim() !== '') &&
    (environment === 'isolated' || cwd.trim() !== '') &&
    // isolated 的 ic 从 task 建副本仓库与副本工单，粘贴的工单先另存为 task
    !(environment === 'isolated' && workflow === 'ic' && onsite);

  return (
    <Card data-testid="new-live">
      <CardHeader>
        <CardTitle>新建交互</CardTitle>
        <CardDescription>
          在真实的 Claude Code 终端中运行 /lfg 或 /ic，不评分、不进入对比。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-5 lg:grid-cols-2">
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-sm font-medium">workflow</legend>
            {(['lfg', 'ic'] as const).map((w) => (
              <label key={w} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="live-workflow"
                  checked={workflow === w}
                  onChange={() => {
                    setWorkflow(w);
                    setTaskId(ONSITE);
                  }}
                />
                /{w}
              </label>
            ))}
          </fieldset>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">variant</span>
            {variants.isError && <span className="text-destructive">{variants.error.message}</span>}
            {variants.data !== undefined && built.length === 0 && (
              <span className="text-muted-foreground">
                没有构建成功的 variant。
                <Link to="/variants" className="underline">
                  去 Variants 页面构建
                </Link>
              </span>
            )}
            {built.length > 0 && (
              <select
                className="h-9 rounded-md border bg-background px-2"
                value={chosenVariant ?? ''}
                data-testid="live-variant"
                onChange={(event) => {
                  setVariantId(event.target.value);
                }}
              >
                {built.map((v) => (
                  <option key={v.id} value={v.id}>
                    {variantLabel(v)}
                  </option>
                ))}
              </select>
            )}
          </label>
        </div>

        <div className="flex flex-col gap-2">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">输入</span>
            <select
              className="h-9 rounded-md border bg-background px-2"
              value={taskId}
              data-testid="live-task"
              onChange={(event) => {
                setTaskId(event.target.value);
              }}
            >
              <option value={ONSITE}>
                {workflow === 'lfg' ? '现场输入想法' : '粘贴 Linear 工单地址'}
              </option>
              {ofKind.map((t) => (
                <option key={t.task.id} value={t.task.id}>
                  task：{t.task.title}
                </option>
              ))}
            </select>
          </label>
          {onsite &&
            (workflow === 'lfg' ? (
              <Textarea
                aria-label="想法"
                placeholder="做一个计算器"
                value={input}
                onChange={(event) => {
                  setInput(event.target.value);
                }}
              />
            ) : (
              <Input
                aria-label="工单地址"
                placeholder="https://linear.app/capso/issue/TXE-3777/… 或 TXE-3777"
                value={input}
                onChange={(event) => {
                  setInput(event.target.value);
                }}
              />
            ))}
          {onsite && input.trim() !== '' && (
            <Link
              to={saveAsTaskHref(workflow, input.trim())}
              className="self-start text-xs underline"
              data-testid="save-as-task"
            >
              另存为 task
            </Link>
          )}
          {environment === 'isolated' && workflow === 'ic' && onsite && (
            <p className="text-xs text-muted-foreground">
              isolated 环境从 task 建副本仓库与副本工单：先把工单另存为 task，再选这个 task。
            </p>
          )}
        </div>

        <div className="grid gap-5 lg:grid-cols-2">
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-sm font-medium">环境</legend>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="live-environment"
                checked={environment === 'isolated'}
                onChange={() => {
                  setEnvironment('isolated');
                }}
              />
              <span>
                isolated：与评估 run 相同，在 txehq 建副本仓库、在 Workflow Eval 建副本工单，进程在
                sandbox 中运行
              </span>
            </label>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="radio"
                name="live-environment"
                checked={environment === 'real'}
                onChange={() => {
                  setEnvironment('real');
                }}
              />
              <span>real：在你填的真实目录中运行</span>
            </label>
            {environment === 'real' && (
              <>
                <Input
                  aria-label="工作目录"
                  placeholder="/Users/you/Project/…"
                  value={cwd}
                  onChange={(event) => {
                    setCwd(event.target.value);
                  }}
                />
                <p
                  role="note"
                  className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900"
                  data-testid="real-warning"
                >
                  会在真实目录、真实仓库与真实工单上写入：用本机的 GitHub 与 Linear
                  凭据，写入不加限制，不开 sandbox。
                </p>
              </>
            )}
          </fieldset>
          <DriverChoice value={driver} onChange={setDriver} name="live-driver" />
        </div>

        {creating.isError && (
          <p role="alert" className="text-sm text-destructive">
            {creating.error.message}
          </p>
        )}
        <div className="flex items-center gap-3">
          <Button
            disabled={!ready || creating.isPending}
            data-testid="live-start"
            onClick={() => {
              if (chosenVariant === null) return;
              creating.mutate({
                workflow,
                input: onsite ? input.trim() : null,
                taskId: onsite ? null : taskId,
                variantId: chosenVariant,
                environment,
                cwd: environment === 'real' ? cwd.trim() : null,
                driver,
              });
            }}
          >
            <Play />
            {creating.isPending
              ? environment === 'isolated'
                ? '正在建副本仓库…'
                : '正在启动…'
              : '启动'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
