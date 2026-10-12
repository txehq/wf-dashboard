import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { PageShell } from '@/components/page-shell';
import { Button } from '@/components/ui/button';
import {
  buildLabel,
  importedLabel,
  isImported,
  request,
  statusLabel,
  type Variant,
  variantLabel,
  variantsQuery,
} from '@/pages/variants-api';
import { QueryError } from '@/pages/variants-error';

function CreateBaseline() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [commit, setCommit] = useState('');
  const create = useMutation({
    mutationFn: () =>
      request<Variant>('POST', '/api/variants', {
        name,
        ...(commit.trim() === '' ? {} : { commit: commit.trim() }),
      }),
    onSuccess: async (variant) => {
      await queryClient.invalidateQueries({ queryKey: ['variants'] });
      await navigate(`/variants/${variant.id}`);
    },
  });
  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded-lg border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <label className="flex flex-col gap-1 text-sm">
        名称
        <input
          className="h-9 w-56 rounded-md border px-3"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
          }}
          required
        />
      </label>
      <label className="flex flex-col gap-1 text-sm">
        txe-workflow commit
        <input
          className="h-9 w-56 rounded-md border px-3 font-mono"
          placeholder="HEAD"
          value={commit}
          onChange={(event) => {
            setCommit(event.target.value);
          }}
        />
      </label>
      <Button type="submit" disabled={create.isPending || name.trim() === ''}>
        {create.isPending ? '导入中…' : '导入基线'}
      </Button>
      {create.isError && <p className="text-sm text-destructive">{create.error.message}</p>}
    </form>
  );
}

export function VariantsPage() {
  const list = useQuery(variantsQuery);
  const byId = new Map(list.data?.map((v) => [v.id, v]));
  return (
    <div className="flex flex-col gap-6">
      <PageShell
        title="Variants"
        description="编辑 skill 内容。variant 属于一个 workflow，模型与 effort 在发起评测时选。"
      />
      <CreateBaseline />
      {list.isPending && <p className="text-sm text-muted-foreground">加载中…</p>}
      {list.isError && (
        <QueryError
          error={list.error}
          retrying={list.isFetching}
          onRetry={() => void list.refetch()}
        />
      )}
      {list.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          还没有 variant。先从 txe-workflow 导入一个基线。
        </p>
      )}
      {list.data !== undefined && list.data.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr className="border-b">
              <th className="py-2 font-medium">名称</th>
              <th className="font-medium">来源</th>
              <th className="font-medium">版本</th>
              <th className="font-medium">状态</th>
              <th className="font-medium">构建</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((variant) => (
              <tr key={variant.id} className="border-b">
                <td className="py-2">
                  <Link className="font-medium underline-offset-4 hover:underline" to={variant.id}>
                    {variantLabel(variant)}
                  </Link>
                </td>
                <td>
                  {variant.parentId === null
                    ? `基线 ${variant.baseCommit.slice(0, 7)}`
                    : `派生自 ${byId.get(variant.parentId)?.name ?? variant.parentId}`}
                </td>
                <td className="font-mono text-xs">{variant.version}</td>
                <td>{statusLabel[variant.status]}</td>
                <td>{isImported(variant) ? importedLabel : buildLabel(variant)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
