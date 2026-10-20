import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play } from 'lucide-react';
import { useState } from 'react';
import { ConfigSelect, LOCAL_CONFIG } from '@/components/live/config-select';
import { DriverChoice } from '@/components/live/resume-dialog';
import { ModelEffortChoice } from '@/components/model-effort';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  createLive,
  isBuiltVariant,
  type LiveDetail,
  type LiveDriver,
  localEntriesQuery,
} from '@/lib/live-api';
import { useModelEffort } from '@/lib/model-effort';
import { defaultLiveVariant, workflowsQuery } from '@/lib/workflows-api';
import { variantsQuery } from '@/pages/variants-api';

type Environment = 'isolated' | 'real';

// 初始命令的选择框中"不加命令"的值
const NO_COMMAND = '';

// isolated 环境下按命令所属 workflow 的评测类型准备什么（Contracts 14.2、29.2）
function isolatedNote(command: string | null, evalKind: 'lfg' | 'ic' | null): string {
  if (command === null) return '只建空的 workspace。';
  if (evalKind === 'lfg') {
    return '在 txehq 建空的副本仓库，写入 vault 的 Project Magi Eval；输入作为想法。';
  }
  if (evalKind === 'ic') {
    return '输入必须是 Linear 工单地址或编号：按工单读取起始仓库与 commit，在 txehq 建仓库副本、在 Workflow Eval 建工单副本。';
  }
  return '没有评测类型：只建空的 workspace。';
}

// 新建交互（Contracts 29.2）：配置 → 初始命令 → 输入 → 环境、驾驶者、model 与 effort。
// 选了 variant 时默认用它的 workflow 的入口命令；选了本机配置时默认不加命令，输入原样发给 agent
export function NewLiveForm({ onCreated }: { onCreated: (live: LiveDetail) => void }) {
  const client = useQueryClient();
  const workflows = useQuery(workflowsQuery);
  const variants = useQuery(variantsQuery);
  const localEntries = useQuery(localEntriesQuery);
  const [config, setConfig] = useState<string | null>(null);
  // undefined：还没有改过，用这个配置的默认值
  const [command, setCommand] = useState<string | null | undefined>(undefined);
  const [input, setInput] = useState('');
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

  const built = (variants.data ?? []).filter(isBuiltVariant);
  // 默认配置：lfg 最新版的 variant（Contracts 29.1），其次 lfg 或任何构建成功的 variant，再没有时为本机配置
  const defaultConfig = defaultLiveVariant(workflows.data, built)?.id ?? LOCAL_CONFIG;
  const chosenConfig =
    config !== null && (config === LOCAL_CONFIG || built.some((v) => v.id === config))
      ? config
      : defaultConfig;
  const variant = built.find((v) => v.id === chosenConfig) ?? null;
  const commands = variant === null ? (localEntries.data?.workflows ?? []) : [variant.workflowId];
  const chosenCommand = command === undefined ? (variant?.workflowId ?? null) : command;
  const commandWorkflow =
    chosenCommand === null ? undefined : workflows.data?.find((w) => w.id === chosenCommand);
  const isIc = commandWorkflow?.evalKind === 'ic';
  const ready =
    variants.data !== undefined &&
    (variant === null || chosenModel !== null) &&
    (chosenCommand === null || commandWorkflow !== undefined) &&
    input.trim() !== '' &&
    (environment === 'isolated' || cwd.trim() !== '');

  return (
    <Card data-testid="new-live">
      <CardHeader>
        <CardTitle>新建交互</CardTitle>
        <CardDescription>在真实的 Claude Code 终端中交互；不评分、不进入对比。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-5 lg:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">配置</span>
            {variants.isError && <span className="text-destructive">{variants.error.message}</span>}
            <ConfigSelect
              value={chosenConfig}
              onChange={(value) => {
                setConfig(value);
                setCommand(undefined);
              }}
              variants={built}
              testId="live-config"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">初始命令</span>
            {localEntries.isError && (
              <span role="alert" className="text-destructive">
                读取本机的入口 skill 失败：{localEntries.error.message}
              </span>
            )}
            <select
              className="h-9 rounded-md border bg-background px-2"
              data-testid="live-command"
              value={chosenCommand ?? NO_COMMAND}
              onChange={(event) => {
                setCommand(event.target.value === NO_COMMAND ? null : event.target.value);
              }}
            >
              <option value={NO_COMMAND}>不加命令</option>
              {commands.map((id) => (
                <option key={id} value={id}>
                  /{id}（{workflows.data?.find((w) => w.id === id)?.name ?? id}）
                </option>
              ))}
            </select>
          </label>
        </div>

        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">输入</span>
          <Textarea
            aria-label="输入"
            placeholder={
              chosenCommand === null
                ? '要发给 agent 的消息'
                : isIc
                  ? 'https://linear.app/capso/issue/TXE-3777/… 或 TXE-3777'
                  : '做一个计算器'
            }
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
            }}
          />
          {chosenCommand === null ? (
            <span className="text-xs text-muted-foreground" data-testid="live-initial-note">
              不加命令：输入原样发给 agent。
            </span>
          ) : (
            <span
              className="font-mono text-xs whitespace-pre-wrap text-muted-foreground"
              data-testid="live-initial"
            >
              /{chosenCommand} {input.trim()}
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
                isolated：进程在 sandbox 中运行
                {variant === null ? '，可以读写 ~/.claude' : ''}。
                <span className="text-muted-foreground" data-testid="live-isolated-note">
                  {' '}
                  {isolatedNote(chosenCommand, commandWorkflow?.evalKind ?? null)}
                </span>
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
                  className="rounded-md border border-warning-border bg-warning px-3 py-2 text-xs text-warning-foreground"
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
            {/* 本机配置不传 --model 与 --effort，用 ~/.claude 自己的设置 */}
            {variant !== null && (
              <ModelEffortChoice
                value={chosenModel}
                onModel={setModel}
                onEffort={setEffort}
                testIdPrefix="live"
              />
            )}
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
              creating.mutate({
                workflow: chosenCommand,
                input: input.trim(),
                variantId: variant?.id ?? null,
                environment,
                cwd: environment === 'real' ? cwd.trim() : null,
                driver,
                ...(variant === null || chosenModel === null ? {} : chosenModel),
              });
            }}
          >
            <Play />
            {creating.isPending
              ? environment === 'isolated' && (commandWorkflow?.evalKind ?? null) !== null
                ? '正在建副本仓库…'
                : '正在启动…'
              : '启动'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
