import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { DriverChoice } from '@/components/live/resume-dialog';
import { ModelEffortChoice } from '@/components/model-effort';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { createLive, isBuiltVariant, type LiveDetail, type LiveDriver } from '@/lib/live-api';
import { useModelEffort } from '@/lib/model-effort';
import { workflowsQuery } from '@/lib/workflows-api';
import { variantsQuery } from '@/pages/variants-api';

type Environment = 'isolated' | 'real';

// isolated 环境下按 workflow 的评测类型准备什么（Contracts 14.2）
function isolatedNote(evalKind: 'lfg' | 'ic' | null): string {
  if (evalKind === 'lfg') {
    return '在 txehq 建空的副本仓库，写入 vault 的 Project Magi Eval；问题作为想法。';
  }
  if (evalKind === 'ic') {
    return '问题必须是 Linear 工单地址或编号：按工单读取起始仓库与 commit，在 txehq 建仓库副本、在 Workflow Eval 建工单副本。';
  }
  return '没有评测类型：只建空的 workspace。';
}

// 新建交互（Contracts 14.2、16.7）：先选 workflow，再选它的 variant，再填一个问题；model 与 effort 在这里选
export function NewLiveForm({ onCreated }: { onCreated: (live: LiveDetail) => void }) {
  const client = useQueryClient();
  const workflows = useQuery(workflowsQuery);
  const variants = useQuery(variantsQuery);
  const [workflowId, setWorkflowId] = useState<string | null>(null);
  const [input, setInput] = useState('');
  const [variantId, setVariantId] = useState<string | null>(null);
  const [environment, setEnvironment] = useState<Environment>('isolated');
  const [cwd, setCwd] = useState('');
  const [driver, setDriver] = useState<LiveDriver>('human');
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  // 默认 model 与 effort 来自设置；还没有读到时不能启动
  const chosenModel = useModelEffort({ model, effort });
  const creating = useMutation({
    mutationFn: createLive,
    onSuccess: async (live) => {
      setInput('');
      await client.invalidateQueries({ queryKey: ['live'] });
      onCreated(live);
    },
  });

  const chosenWorkflow = workflows.data?.find((w) => w.id === (workflowId ?? 'lfg'));
  const built = (variants.data ?? []).filter(
    (v) => isBuiltVariant(v) && v.workflowId === chosenWorkflow?.id,
  );
  const chosenVariant = built.find((v) => v.id === variantId)?.id ?? built[0]?.id ?? null;
  const ready =
    chosenWorkflow !== undefined &&
    chosenVariant !== null &&
    chosenModel !== null &&
    input.trim() !== '' &&
    (environment === 'isolated' || cwd.trim() !== '');
  const isIc = chosenWorkflow?.evalKind === 'ic';

  return (
    <Card data-testid="new-live">
      <CardHeader>
        <CardTitle>新建交互</CardTitle>
        <CardDescription>
          在真实的 Claude Code 终端中运行一个 workflow，初始消息为 /&lt;workflow&gt;
          &lt;问题&gt;；不评分、不进入对比。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-5 lg:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">workflow</span>
            {workflows.isError && (
              <span className="text-destructive">{workflows.error.message}</span>
            )}
            <select
              className="h-9 rounded-md border bg-background px-2"
              data-testid="live-workflow"
              value={chosenWorkflow?.id ?? ''}
              onChange={(event) => {
                setWorkflowId(event.target.value);
                setVariantId(null);
              }}
            >
              {workflows.data?.map((w) => (
                <option key={w.id} value={w.id}>
                  /{w.id}（{w.name}）
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">variant</span>
            {variants.isError && <span className="text-destructive">{variants.error.message}</span>}
            {variants.data !== undefined && chosenWorkflow !== undefined && built.length === 0 && (
              <span className="text-muted-foreground" data-testid="live-no-variant">
                /{chosenWorkflow.id} 还没有构建成功的 variant。
                <Link to={`/workflows/${chosenWorkflow.id}`} className="underline">
                  去 workflow 页面构建
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
                    {v.name}
                  </option>
                ))}
              </select>
            )}
          </label>
        </div>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">问题</span>
          {isIc ? (
            <Input
              aria-label="问题"
              placeholder="https://linear.app/capso/issue/TXE-3777/… 或 TXE-3777"
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
              }}
            />
          ) : (
            <Textarea
              aria-label="问题"
              placeholder="做一个计算器"
              value={input}
              onChange={(event) => {
                setInput(event.target.value);
              }}
            />
          )}
          {chosenWorkflow !== undefined && (
            <span className="font-mono text-xs text-muted-foreground" data-testid="live-initial">
              /{chosenWorkflow.id} {input.trim()}
            </span>
          )}
        </label>

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
                isolated：进程在 sandbox 中运行。
                {chosenWorkflow !== undefined && (
                  <span className="text-muted-foreground" data-testid="live-isolated-note">
                    {' '}
                    {isolatedNote(chosenWorkflow.evalKind)}
                  </span>
                )}
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
          <div className="flex flex-col gap-4">
            <DriverChoice value={driver} onChange={setDriver} name="live-driver" />
            <ModelEffortChoice
              value={chosenModel}
              onModel={setModel}
              onEffort={setEffort}
              testIdPrefix="live"
            />
          </div>
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
              if (chosenWorkflow === undefined || chosenVariant === null || chosenModel === null) {
                return;
              }
              creating.mutate({
                workflow: chosenWorkflow.id,
                input: input.trim(),
                variantId: chosenVariant,
                environment,
                cwd: environment === 'real' ? cwd.trim() : null,
                driver,
                ...chosenModel,
              });
            }}
          >
            <Play />
            {creating.isPending
              ? environment === 'isolated' && chosenWorkflow?.evalKind !== null
                ? '正在建副本仓库…'
                : '正在启动…'
              : '启动'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
