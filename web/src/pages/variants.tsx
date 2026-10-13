import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, GitBranchPlus, Hammer, Save, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, Navigate, useNavigate, useParams } from 'react-router';
import { useFullscreen } from '@/components/fullscreen';
import { OpenInFinder } from '@/components/open-in-finder';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { VariantHistoryButton } from '@/components/variant-history';
import { formatDateTime } from '@/lib/format';
import { type WorkflowRecord, workflowsQuery } from '@/lib/workflows-api';
import { VariantWorkspace } from '@/pages/variant-workspace';
import {
  buildLabel,
  importedLabel,
  type InstallManifest,
  installQuery,
  isImported,
  request,
  statusLabel,
  type Variant,
  variantHref,
  variantLabel,
  variantQuery,
} from '@/pages/variants-api';
import { QueryError } from '@/pages/variants-error';

// /variants 没有单独的页面（Contracts 16.7）：variant 从 Workflows 列表与 workflow 页面进入
export function VariantsRedirect() {
  return <Navigate to="/workflows" replace />;
}

// 页面头部一行的操作（Contracts 20.2）：构建、派生新 variant、在访达中打开、安装到本机。出错时的原文由调用方显示
function useVariantActions(variant: Variant, onBuildStart: () => void) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['variants'] });
  };
  const build = useMutation({
    mutationFn: () => request<Variant>('POST', `/api/variants/${variant.id}/build`),
    onMutate: onBuildStart,
    onSettled: refresh,
  });
  const derive = useMutation({
    mutationFn: (name: string) =>
      request<Variant>('POST', `/api/variants/${variant.id}/derive`, { name }),
    onSuccess: async (created) => {
      await refresh();
      await navigate(variantHref(created));
    },
  });
  const install = useMutation({
    mutationFn: () =>
      request<{ installed: InstallManifest; replaced: InstallManifest[] }>(
        'POST',
        `/api/variants/${variant.id}/install`,
      ),
    onSuccess: refresh,
  });
  const uninstall = useMutation({
    mutationFn: () => request('DELETE', `/api/variants/${variant.id}/install`),
    onSuccess: refresh,
  });
  return { build, derive, install, uninstall };
}

function HeaderActions({
  variant,
  workflow,
  actions,
  installed,
}: {
  variant: Variant;
  workflow: WorkflowRecord;
  actions: ReturnType<typeof useVariantActions>;
  installed: InstallManifest | null | undefined;
}) {
  const { build, derive, install, uninstall } = actions;
  const frozen = variant.status === 'frozen';
  const imported = isImported(variant);
  const building = build.isPending || variant.buildStatus === 'building';
  const built = variant.buildStatus === 'built' && variant.builtHash === variant.skillsHash;
  return (
    <div className="ml-auto flex flex-wrap items-center gap-2" data-testid="variant-actions">
      {!frozen && !imported && (
        <Button
          size="sm"
          disabled={building}
          onClick={() => {
            build.mutate();
          }}
        >
          <Hammer />
          {building ? '构建中…' : '构建'}
        </Button>
      )}
      <Button
        size="sm"
        variant={frozen || imported ? 'default' : 'outline'}
        disabled={derive.isPending}
        title="从这个 variant 复制出一个新的草稿，在同一 workflow 中"
        onClick={() => {
          const name = window.prompt(
            '新 variant 名称',
            imported ? `${variant.name}（可运行）` : `${variant.name} 副本`,
          );
          if (name !== null && name.trim() !== '') derive.mutate(name.trim());
        }}
      >
        <GitBranchPlus />
        {imported ? '派生为可运行的 variant' : '派生新 variant'}
      </Button>
      <OpenInFinder target={{ kind: 'variant', id: variant.id }} label="在访达中打开" />
      <VariantHistoryButton variant={variant} />
      {/* 安装到本机只对不用 wf 管理的 workflow（Contracts 18.6） */}
      {!workflow.wf && (
        <span className="contents" data-testid="local-install">
          {installed === null || installed === undefined ? (
            <Button
              size="sm"
              variant="outline"
              disabled={!built || install.isPending || installed === undefined}
              title={
                built
                  ? '把 skill 复制进本机的 ~/.claude/skills 与 ~/.agents/skills；同一 workflow 只装一个 variant'
                  : '按当前内容构建通过后才能安装'
              }
              onClick={() => {
                install.mutate();
              }}
            >
              <Download />
              {install.isPending ? '安装中…' : '安装到本机'}
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={uninstall.isPending}
              title={`装在：\n${installed.dirs.join('\n')}`}
              onClick={() => {
                uninstall.mutate();
              }}
            >
              <Trash2 />
              {uninstall.isPending ? '卸载中…' : '从本机卸载'}
            </Button>
          )}
        </span>
      )}
    </div>
  );
}

// 状态、版本与来源，放在一行
function StatusLine({
  variant,
  workflow,
  installed,
}: {
  variant: Variant;
  workflow: WorkflowRecord;
  installed: InstallManifest | null | undefined;
}) {
  const imported = isImported(variant);
  const parent = useQuery({
    ...variantQuery(variant.parentId ?? ''),
    enabled: variant.parentId !== null,
  });
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
      <span className="rounded-md border px-2 py-0.5 text-xs text-foreground">
        {statusLabel[variant.status]}
      </span>
      <span
        className="rounded-md border px-2 py-0.5 text-xs text-foreground"
        data-testid="build-status"
      >
        {imported ? importedLabel : buildLabel(variant)}
      </span>
      <span className="font-mono text-xs" data-testid="variant-version">
        {variant.version}
        {variant.baseCommit !== '' && ` · 基线 ${variant.baseCommit.slice(0, 7)}`}
      </span>
      {!workflow.wf && (
        <span data-testid="local-install-status" title={installed?.dirs.join('\n')}>
          {installed === undefined
            ? '读取安装状态…'
            : installed === null
              ? '没有装在本机'
              : `已装在本机（${formatDateTime(new Date(installed.installedAt).toISOString())}）`}
        </span>
      )}
      {variant.parentId !== null && (
        <span data-testid="variant-parent">
          派生自{' '}
          {parent.data === undefined ? (
            variant.parentId
          ) : (
            <Link className="underline" to={variantHref(parent.data)}>
              {variantLabel(parent.data)}
            </Link>
          )}
          {parent.data !== undefined && isImported(parent.data) && '（导入的 variant）'}
        </span>
      )}
      {variant.storageId !== null && (
        <span data-testid="variant-shared">与另一个 workflow 的同名 variant 共用目录</span>
      )}
      {variant.analysisId !== null && (
        <span data-testid="variant-analysis">
          来自分析{' '}
          <Link className="font-mono underline" to={`/analyses/${variant.analysisId}`}>
            {variant.analysisId}
          </Link>
        </span>
      )}
      {variant.sourceSessionId !== null && (
        <span data-testid="variant-source-session">
          按 session{' '}
          <Link className="font-mono underline" to={`/sessions/${variant.sourceSessionId}`}>
            {variant.sourceSessionId.slice(0, 8)}
          </Link>{' '}
          的 skill 新建
        </span>
      )}
      {variant.draftId !== null && (
        <span data-testid="variant-draft">
          来自 Codex 草稿 <span className="font-mono">{variant.draftId}</span>
        </span>
      )}
      {variant.status === 'frozen' && !imported && <span>已被运行使用，内容只读</span>}
    </div>
  );
}

// 描述（Contracts 18.3）：输入框与保存按钮在同一行
function DescriptionLine({ variant }: { variant: Variant }) {
  const client = useQueryClient();
  const [text, setText] = useState(variant.description ?? '');
  const save = useMutation({
    mutationFn: () => request('PATCH', `/api/variants/${variant.id}`, { description: text }),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['variants'] });
    },
  });
  const changed = text.trim() !== (variant.description ?? '').trim();
  return (
    <div className="flex items-center gap-2 text-sm" data-testid="description-editor">
      <input
        className="h-8 min-w-0 flex-1 rounded-md border bg-background px-2"
        aria-label="描述"
        placeholder="写一句这是做什么的"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && changed) save.mutate();
        }}
      />
      <Button
        size="sm"
        variant="outline"
        disabled={!changed || save.isPending}
        onClick={() => {
          save.mutate();
        }}
      >
        <Save />
        {save.isPending ? '保存中…' : '保存描述'}
      </Button>
      {save.isSuccess && !changed && (
        <span className="text-xs text-muted-foreground" data-testid="description-saved">
          已保存
        </span>
      )}
      {save.isError && <span className="text-destructive">{save.error.message}</span>}
    </div>
  );
}

function VariantBody({ variant, workflow }: { variant: Variant; workflow: WorkflowRecord }) {
  const fullscreen = useFullscreen();
  const [logOpen, setLogOpen] = useState(false);
  const actions = useVariantActions(variant, () => {
    setLogOpen(true);
  });
  const install = useQuery({ ...installQuery(variant.id), enabled: !workflow.wf });
  const installed = install.data?.installed;
  const building = actions.build.isPending || variant.buildStatus === 'building';
  const error =
    actions.build.error ??
    actions.derive.error ??
    actions.install.error ??
    actions.uninstall.error ??
    install.error;
  return (
    <div className="flex flex-col gap-3" data-testid="variant-panel">
      {/* 头部一行：面包屑与名字在左，操作在右 */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <nav
          aria-label="位置"
          className="min-w-0 text-sm text-muted-foreground"
          data-testid="breadcrumb"
        >
          <Link className="underline-offset-4 hover:underline" to="/workflows">
            Workflows
          </Link>
          {' › '}
          <Link className="underline-offset-4 hover:underline" to={`/workflows/${workflow.id}`}>
            {workflow.name}
          </Link>
          {' › '}
          <h1 className="inline text-xl font-semibold text-foreground">{variant.name}</h1>
        </nav>
        <HeaderActions
          variant={variant}
          workflow={workflow}
          actions={actions}
          installed={installed}
        />
      </div>
      <StatusLine variant={variant} workflow={workflow} installed={installed} />
      {variant.buildStatus === 'failed' && variant.buildError !== null && (
        <p className="text-sm text-destructive" data-testid="build-error">
          构建失败：{variant.buildError}
        </p>
      )}
      {actions.install.data !== undefined && actions.install.data.replaced.length > 0 && (
        <p className="text-sm text-muted-foreground">
          先卸载了同一 workflow 的{' '}
          {actions.install.data.replaced.map((m) => m.variantName).join('、')}。
        </p>
      )}
      {error !== null && (
        <Alert variant="destructive">
          <AlertTitle>操作没有完成</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">{error.message}</AlertDescription>
        </Alert>
      )}
      {/* VariantBody 按 variant id 重新挂载，这里的状态跟着换 */}
      <DescriptionLine variant={variant} />
      <VariantWorkspace
        variant={variant}
        fullscreen={fullscreen}
        building={building}
        logOpen={logOpen}
        onLogOpen={setLogOpen}
      />
    </div>
  );
}

// variant 的独立页面（Contracts 18.3、20.2）
export function VariantPage() {
  const { id } = useParams();
  if (id === undefined) throw new Error('路由缺少 variant id');
  const variant = useQuery(variantQuery(id));
  const workflows = useQuery(workflowsQuery);
  if (variant.isPending || workflows.isPending) {
    return <p className="text-sm text-muted-foreground">加载中…</p>;
  }
  if (variant.isError) {
    return (
      <QueryError
        error={variant.error}
        retrying={variant.isFetching}
        onRetry={() => void variant.refetch()}
      />
    );
  }
  if (workflows.isError) {
    return <p className="text-sm text-destructive">{workflows.error.message}</p>;
  }
  const workflow = workflows.data.find((w) => w.id === variant.data.workflowId);
  if (workflow === undefined) throw new Error(`没有 workflow ${variant.data.workflowId}`);
  return <VariantBody key={variant.data.id} variant={variant.data} workflow={workflow} />;
}
