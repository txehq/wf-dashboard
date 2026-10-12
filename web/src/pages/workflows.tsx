import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { CodexDraftForm } from '@/components/codex-draft';
import { PageShell } from '@/components/page-shell';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  createWorkflow,
  evalKindLabel,
  type WorkflowRecord,
  workflowsQuery,
} from '@/lib/workflows-api';
import { variantLabel, variantsQuery } from '@/pages/variants-api';

// 复制：选一个已有 variant 作来源，填 id 与名字，勾选是否保留评测类型（默认保留）；定义先复制来源 workflow 的定义
export function NewWorkflowForm({
  initialVariantId,
  onCancel,
}: {
  initialVariantId?: string | undefined;
  onCancel: () => void;
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const variants = useQuery(variantsQuery);
  const workflows = useQuery(workflowsQuery);
  const [variantId, setVariantId] = useState(initialVariantId ?? '');
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [keepEvalKind, setKeepEvalKind] = useState(true);
  const source = variants.data?.find((v) => v.id === variantId);
  const from = workflows.data?.find((w) => w.id === source?.workflowId);
  const create = useMutation({
    mutationFn: () => {
      if (from === undefined) throw new Error('还没有选来源 variant');
      return createWorkflow({
        id,
        name,
        fromVariantId: variantId,
        keepEvalKind,
        definition: { ...from.definition, id, name },
      });
    },
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: ['workflows'] });
      await client.invalidateQueries({ queryKey: ['variants'] });
      await navigate(`/workflows/${created.id}`);
    },
  });
  return (
    <form
      className="flex flex-col gap-4 rounded-lg border p-4"
      data-testid="new-workflow"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <h2 className="text-base font-semibold">复制为新 workflow</h2>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          来源 variant
          <select
            className="h-9 w-72 rounded-md border bg-background px-2"
            data-testid="new-workflow-source"
            value={variantId}
            onChange={(event) => {
              setVariantId(event.target.value);
            }}
            required
          >
            <option value="">选择…</option>
            {variants.data?.map((v) => (
              <option key={v.id} value={v.id}>
                {variantLabel(v)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          id（入口命令 /id）
          <input
            className="h-9 w-48 rounded-md border px-3 font-mono"
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
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            required
          />
        </label>
        <label className="flex h-9 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={keepEvalKind}
            onChange={(event) => {
              setKeepEvalKind(event.target.checked);
            }}
          />
          保留评测类型{from === undefined ? '' : `（${evalKindLabel(from.evalKind)}）`}
        </label>
      </div>
      {from !== undefined && (
        <p className="text-sm text-muted-foreground">
          定义复制自 {from.name}：{from.definition.stages.map((s) => s.id).join('、')}
          ；来源 variant 的入口 skill /{from.id} 在副本中改名为 /{id === '' ? '<id>' : id}。
        </p>
      )}
      {create.isError && (
        <Alert variant="destructive">
          <AlertTitle>新建失败</AlertTitle>
          <AlertDescription>{create.error.message}</AlertDescription>
        </Alert>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={create.isPending || variantId === '' || id === '' || name === ''}
        >
          {create.isPending ? '复制中…' : '新建'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}

function WorkflowRow({ workflow }: { workflow: WorkflowRecord }) {
  return (
    <tr className="border-b" data-testid={`workflow-row-${workflow.id}`}>
      <td className="py-2">
        <Link className="font-medium underline-offset-4 hover:underline" to={workflow.id}>
          {workflow.name}
        </Link>
        {workflow.builtin && <span className="ml-2 text-xs text-muted-foreground">内置</span>}
      </td>
      <td className="font-mono">/{workflow.id}</td>
      <td>{evalKindLabel(workflow.evalKind)}</td>
      <td>{workflow.definition.stages.length}</td>
      <td>{workflow.variants}</td>
    </tr>
  );
}

// Contracts 16.7：Workflows 列表与新建
export function WorkflowsPage() {
  const list = useQuery(workflowsQuery);
  const [creating, setCreating] = useState<'copy' | 'codex' | null>(null);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageShell
          title="Workflows"
          description="workflow 是一个入口命令加一串小阶段；variant 是它的实例。内置的 lfg、ic 只读，要改就复制。"
        />
        <div className="flex gap-2">
          <Button
            onClick={() => {
              setCreating('copy');
            }}
          >
            <Plus />
            新建 workflow
          </Button>
          <Button
            variant="outline"
            data-testid="codex-workflow-toggle"
            onClick={() => {
              setCreating('codex');
            }}
          >
            <Sparkles />用 Codex 生成 workflow
          </Button>
        </div>
      </div>
      {creating === 'copy' && (
        <NewWorkflowForm
          onCancel={() => {
            setCreating(null);
          }}
        />
      )}
      {creating === 'codex' && (
        <CodexDraftForm
          mode="workflow"
          onCancel={() => {
            setCreating(null);
          }}
        />
      )}
      {list.isPending && <p className="text-sm text-muted-foreground">加载中…</p>}
      {list.isError && (
        <Alert variant="destructive">
          <AlertTitle>无法读取 workflow 列表</AlertTitle>
          <AlertDescription>{list.error.message}</AlertDescription>
        </Alert>
      )}
      {list.data !== undefined && (
        <table className="w-full text-sm" data-testid="workflows-table">
          <thead className="text-left text-muted-foreground">
            <tr className="border-b">
              <th className="py-2 font-medium">名字</th>
              <th className="font-medium">入口命令</th>
              <th className="font-medium">评测类型</th>
              <th className="font-medium">小阶段数</th>
              <th className="font-medium">variant 数</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((w) => (
              <WorkflowRow key={w.id} workflow={w} />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
