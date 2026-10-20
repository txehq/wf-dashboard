import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RotateCcw, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { EngineChoice } from '@/components/engine-choice';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { createDraft, type Draft, type DraftStepView } from '@/lib/drafts-api';
import { formatDuration } from '@/lib/format';
import { useDesignEngine } from '@/lib/design-engine';
import { useNow } from '@/lib/use-now';
import { type Variant, variantLabel, variantsQuery } from '@/pages/variants-api';

// 最早建出的 variant（列表按创建时间倒序）：默认的底子
function earliest(variants: Variant[]): Variant | undefined {
  return variants.reduce<Variant | undefined>(
    (first, v) => (first === undefined || v.createdAt < first.createdAt ? v : first),
    undefined,
  );
}

// Contracts 17.1、22.1、28.4："生成 workflow"（Workflows 列表）与"生成 variant"（Workflow 页面），引擎为 Codex 或
// Claude Code（默认上次选的）。发起后服务端建草稿目录、装 skill、在 Live 中建会话，页面跳到它
export function CodexDraftForm({
  mode,
  workflowId,
  onCancel,
}: {
  mode: 'workflow' | 'variant';
  // mode 为 variant 时是所属 workflow
  workflowId?: string | undefined;
  onCancel: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const variants = useQuery(variantsQuery);
  // mode 为 variant 时底子默认是这个 workflow 的第一个 variant；mode 为 workflow 时从空白骨架开始（Contracts 18.5）
  const choices = (variants.data ?? []).filter((v) => v.workflowId === workflowId);
  const fallback = earliest(choices);
  const [engine, setEngine] = useDesignEngine();
  const [baseVariantId, setBaseVariantId] = useState('');
  const base = baseVariantId === '' ? (fallback?.id ?? '') : baseVariantId;
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [requirement, setRequirement] = useState('');
  const create = useMutation({
    mutationFn: () =>
      createDraft(
        mode === 'workflow'
          ? { mode, engine, workflowId: id, name, description, requirement }
          : { mode, engine, workflowId: workflowId ?? '', requirement, baseVariantId: base },
      ),
    onSuccess: async ({ live }) => {
      await client.invalidateQueries({ queryKey: ['live'] });
      await navigate(`/live?item=${live.id}`);
    },
  });
  const ready =
    requirement.trim() !== '' && (mode === 'variant' ? base !== '' : id !== '' && name !== '');
  return (
    <form
      className="flex flex-col gap-4 rounded-lg border p-4"
      data-testid={`codex-draft-${mode}`}
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">
          {mode === 'workflow' ? '生成 workflow' : `生成 /${workflowId ?? ''} 的 variant`}
        </h2>
        <EngineChoice value={engine} onChange={setEngine} />
      </div>
      <div className="flex flex-wrap items-end gap-3">
        {mode === 'workflow' && (
          <>
            <label className="flex flex-col gap-1 text-sm">
              id（入口命令 /id）
              <input
                className="h-9 w-48 rounded-md border px-3 font-mono"
                data-testid="codex-draft-id"
                value={id}
                onChange={(event) => {
                  setId(event.target.value);
                }}
                required
              />
            </label>
            <label className="flex flex-col gap-1 text-sm">
              名字
              <input
                className="h-9 w-56 rounded-md border px-3"
                data-testid="codex-draft-name"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                }}
                required
              />
            </label>
          </>
        )}
        {mode === 'variant' && (
          <label className="flex flex-col gap-1 text-sm">
            底子 variant
            <select
              className="h-9 w-72 rounded-md border bg-background px-2"
              data-testid="codex-draft-base"
              value={base}
              onChange={(event) => {
                setBaseVariantId(event.target.value);
              }}
              required
            >
              {base === '' && <option value="">选择…</option>}
              {choices.map((v) => (
                <option key={v.id} value={v.id}>
                  {variantLabel(v)}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      {mode === 'workflow' && (
        <label className="flex flex-col gap-1 text-sm">
          描述
          <textarea
            className="min-h-14 rounded-md border px-3 py-2"
            data-testid="codex-draft-description"
            value={description}
            onChange={(event) => {
              setDescription(event.target.value);
            }}
          />
        </label>
      )}
      <label className="flex flex-col gap-1 text-sm">
        需求
        <textarea
          className="min-h-20 rounded-md border px-3 py-2"
          data-testid="codex-draft-requirement"
          value={requirement}
          onChange={(event) => {
            setRequirement(event.target.value);
          }}
          required
        />
      </label>
      <p className="text-sm text-muted-foreground">
        {mode === 'workflow'
          ? '草稿从空白骨架开始（入口与一个小阶段的 SKILL.md）；写好 skill 与小阶段后，在 Live 中保存为新 workflow。'
          : '只改 skill 内容，入口与小阶段不变；写好后，在 Live 中保存为新 variant。'}
      </p>
      {create.isError && (
        <Alert variant="destructive">
          <AlertTitle>发起失败</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">
            {create.error.message}
          </AlertDescription>
        </Alert>
      )}
      <div className="flex items-center gap-2">
        <Button
          type="submit"
          disabled={!ready || create.isPending}
          data-testid="codex-draft-submit"
        >
          <Sparkles />
          {create.isPending ? '发起中…' : '在 Live 中开始'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}

const stepLabel: Record<DraftStepView['status'], string> = {
  pending: '等待',
  running: '进行中…',
  done: '完成',
  failed: '失败',
};

// 一步的实际耗时：完成或失败的是开始到结束，进行中的是到现在
function stepDuration(step: DraftStepView, now: number): string | null {
  if (step.startedAt === null) return null;
  return formatDuration((step.endedAt ?? now) - step.startedAt);
}

// 草稿准备的每一步（Contracts 17.1、28.4）：每一步写实际耗时；失败时显示那一步的原文与"重试准备"
export function DraftProgress({
  draft,
  retrying,
  onRetry,
}: {
  draft: Draft;
  retrying: boolean;
  onRetry: () => void;
}) {
  const now = useNow(draft.status === 'preparing');
  return (
    <div
      className="flex flex-col gap-2 rounded-md border p-3 text-sm"
      data-testid="codex-draft-progress"
      data-status={draft.status}
    >
      <p className="font-medium">
        {draft.status === 'preparing'
          ? `正在准备草稿目录，完成后启动 ${draft.engine === 'codex' ? 'Codex' : 'Claude Code'}`
          : '准备失败，草稿保留'}
      </p>
      <ol className="flex flex-col gap-1">
        {draft.steps.map((step) => {
          const duration = stepDuration(step, now);
          return (
            <li
              key={step.id}
              data-testid="codex-draft-step"
              data-step={step.id}
              data-status={step.status}
            >
              <span className="inline-block w-16 text-muted-foreground">
                {stepLabel[step.status]}
              </span>
              {step.label}
              {duration !== null && (
                <span
                  className="ml-2 text-xs text-muted-foreground tabular-nums"
                  data-testid="codex-draft-step-duration"
                >
                  {duration}
                </span>
              )}
              {step.error !== null && (
                <pre className="mt-1 max-h-60 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap text-destructive">
                  {step.error}
                </pre>
              )}
            </li>
          );
        })}
      </ol>
      {draft.status === 'failed' && (
        <Button
          size="sm"
          variant="outline"
          className="w-fit"
          data-testid="codex-draft-retry"
          disabled={retrying}
          onClick={onRetry}
        >
          <RotateCcw />
          重试准备
        </Button>
      )}
    </div>
  );
}
