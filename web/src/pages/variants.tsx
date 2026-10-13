import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Trash2 } from 'lucide-react';
import { Link, Navigate, useParams } from 'react-router';
import { DescriptionEditor } from '@/components/description-editor';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { formatDateTime } from '@/lib/format';
import { workflowsQuery } from '@/lib/workflows-api';
import { VariantPanel } from '@/pages/variant-panel';
import {
  type InstallManifest,
  installQuery,
  request,
  type Variant,
  variantQuery,
} from '@/pages/variants-api';
import { QueryError } from '@/pages/variants-error';

// /variants 没有单独的页面（Contracts 16.7）：variant 从 Workflows 列表与 workflow 页面进入
export function VariantsRedirect() {
  return <Navigate to="/workflows" replace />;
}

// 安装到本机（Contracts 18.6）：只对任意 workflow 的 variant；同一 workflow 只装一个，装另一个时先卸载前一个
function LocalInstall({ variant }: { variant: Variant }) {
  const client = useQueryClient();
  const status = useQuery(installQuery(variant.id));
  const refresh = async () => {
    await client.invalidateQueries({ queryKey: ['variants'] });
  };
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
  const built = variant.buildStatus === 'built' && variant.builtHash === variant.skillsHash;
  const installed = status.data?.installed ?? null;
  const error = install.error ?? uninstall.error;
  return (
    <section className="flex flex-col gap-2 rounded-lg border p-4" data-testid="local-install">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">安装到本机</h2>
        <span className="text-sm text-muted-foreground" data-testid="local-install-status">
          {status.isPending
            ? '读取中…'
            : installed === null
              ? '没有装在本机'
              : `已装在本机（${formatDateTime(new Date(installed.installedAt).toISOString())}）`}
        </span>
        <div className="ml-auto flex gap-2">
          {installed === null ? (
            <Button
              size="sm"
              disabled={!built || install.isPending}
              title={built ? undefined : '按当前内容构建通过后才能安装'}
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
              onClick={() => {
                uninstall.mutate();
              }}
            >
              <Trash2 />
              {uninstall.isPending ? '卸载中…' : '从本机卸载'}
            </Button>
          )}
        </div>
      </div>
      <p className="text-sm text-muted-foreground">
        把这个 variant 的 skill 复制进本机的 Claude Code 与 Codex 的 skill 目录，在 dashboard
        之外也能用 /{variant.workflowId}。同一 workflow 同一时间只装一个 variant。
      </p>
      {installed !== null && (
        <ul className="flex flex-col gap-0.5 font-mono text-xs" data-testid="local-install-dirs">
          {installed.dirs.map((dir) => (
            <li key={dir}>{dir}</li>
          ))}
        </ul>
      )}
      {install.data !== undefined && install.data.replaced.length > 0 && (
        <p className="text-sm text-muted-foreground">
          先卸载了同一 workflow 的 {install.data.replaced.map((m) => m.variantName).join('、')}。
        </p>
      )}
      {status.isError && <p className="text-sm text-destructive">{status.error.message}</p>}
      {error !== null && (
        <Alert variant="destructive">
          <AlertTitle>{install.isError ? '没有安装' : '没有卸载'}</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">{error.message}</AlertDescription>
        </Alert>
      )}
    </section>
  );
}

// variant 的独立页面（Contracts 18.3）：Workflows › workflow › variant；描述、文件树、编辑、对比、构建、派生与安装到本机
export function VariantPage() {
  const { id } = useParams();
  if (id === undefined) throw new Error('路由缺少 variant id');
  const client = useQueryClient();
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
  const v = variant.data;
  const workflow = workflows.data.find((w) => w.id === v.workflowId);
  if (workflow === undefined) throw new Error(`没有 workflow ${v.workflowId}`);
  return (
    <div className="flex flex-col gap-5">
      <nav aria-label="位置" className="text-sm text-muted-foreground" data-testid="breadcrumb">
        <Link className="underline-offset-4 hover:underline" to="/workflows">
          Workflows
        </Link>
        {' › '}
        <Link className="underline-offset-4 hover:underline" to={`/workflows/${workflow.id}`}>
          {workflow.name}
        </Link>
        {' › '}
        <span className="text-foreground">{v.name}</span>
      </nav>
      <h1 className="text-2xl font-semibold">
        {v.name} <span className="font-mono text-base text-muted-foreground">/{workflow.id}</span>
      </h1>
      <DescriptionEditor
        key={v.id}
        label="描述"
        value={v.description}
        onSave={async (description) => {
          await request('PATCH', `/api/variants/${v.id}`, { description });
          await client.invalidateQueries({ queryKey: ['variants'] });
        }}
      />
      {!workflow.builtin && <LocalInstall variant={v} />}
      <VariantPanel key={v.id} id={v.id} />
    </div>
  );
}
