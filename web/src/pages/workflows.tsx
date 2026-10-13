import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkflowDefinition } from '@wf-dashboard/server/workflows/schema';
import { ChevronDown, ChevronRight, Plus, Sparkles } from 'lucide-react';
import { Fragment, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { CodexDraftForm } from '@/components/codex-draft';
import { PageShell } from '@/components/page-shell';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { StageFlow } from '@/components/workflow-flow';
import { formatDateTime } from '@/lib/format';
import {
  createWorkflow,
  evalKindLabel,
  type WorkflowRecord,
  workflowsQuery,
} from '@/lib/workflows-api';
import {
  buildLabel,
  importedLabel,
  isImported,
  statusLabel,
  type Variant,
  variantHref,
  variantsQuery,
} from '@/pages/variants-api';
import { DefinitionForm } from '@/pages/workflow-config';

// 从空白新建（Contracts 18.5）：id、名字、描述与小阶段；没有评测类型。同时建出第一个 variant"初稿"
function BlankWorkflowForm({ onCancel }: { onCancel: () => void }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [id, setId] = useState('');
  const [description, setDescription] = useState('');
  const [definition, setDefinition] = useState<WorkflowDefinition>({
    id: '',
    name: '',
    stages: [],
  });
  const create = useMutation({
    mutationFn: () =>
      createWorkflow({
        id,
        name: definition.name,
        description,
        definition: { ...definition, id },
      }),
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: ['workflows'] });
      await client.invalidateQueries({ queryKey: ['variants'] });
      await navigate(`/workflows/${created.id}`);
    },
  });
  const ready = id !== '' && definition.name.trim() !== '' && definition.stages.length > 0;
  return (
    <form
      className="flex flex-col gap-4 rounded-lg border p-4"
      data-testid="new-workflow"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <h2 className="text-base font-semibold">从空白新建 workflow</h2>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">id（入口命令 /id，也是入口 skill 的名字）</span>
        <input
          className="h-9 w-56 rounded-md border bg-background px-3 font-mono"
          value={id}
          onChange={(event) => {
            setId(event.target.value.trim());
          }}
          required
        />
      </label>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">描述</span>
        <textarea
          className="min-h-16 max-w-3xl rounded-md border bg-background px-3 py-2"
          value={description}
          placeholder="写一句这是做什么的"
          onChange={(event) => {
            setDescription(event.target.value);
          }}
        />
      </label>
      <DefinitionForm
        definition={{ ...definition, id }}
        skillNames={[]}
        readOnly={false}
        onChange={setDefinition}
      />
      {id !== '' && definition.stages.length > 0 && (
        <StageFlow definition={{ ...definition, id }} />
      )}
      <p className="text-sm text-muted-foreground">
        新建后有一个 variant「初稿」：入口与每个小阶段各一个只有 frontmatter 与一行说明的
        SKILL.md，在 variant 页面中写成完整的 skill。新 workflow 没有评测类型，用于
        Live、阶段划分与分析。
      </p>
      {create.isError && (
        <Alert variant="destructive">
          <AlertTitle>新建失败</AlertTitle>
          <AlertDescription className="whitespace-pre-wrap">
            {create.error.message}
          </AlertDescription>
        </Alert>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={!ready || create.isPending}>
          {create.isPending ? '新建中…' : '新建'}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          取消
        </Button>
      </div>
    </form>
  );
}

// 一个 workflow 的 variant（Contracts 18.3）：名字链接到 variant 页面
export function VariantRows({ variants }: { variants: (Variant & { boundSessions: number })[] }) {
  if (variants.length === 0) {
    return <p className="text-sm text-muted-foreground">这个 workflow 还没有 variant。</p>;
  }
  return (
    <table className="w-full text-sm" data-testid="variant-table">
      <thead className="text-left text-muted-foreground">
        <tr className="border-b">
          <th className="py-1.5 font-medium">名字</th>
          <th className="font-medium">描述</th>
          <th className="font-medium">状态</th>
          <th className="font-medium">构建</th>
          <th className="font-medium">构建时间</th>
          <th className="font-medium">绑定的 session</th>
        </tr>
      </thead>
      <tbody>
        {variants.map((v) => (
          <tr key={v.id} className="border-b last:border-b-0" data-testid={`variant-row-${v.name}`}>
            <td className="py-1.5">
              <Link className="font-medium underline-offset-4 hover:underline" to={variantHref(v)}>
                {v.name}
              </Link>
            </td>
            <td className="max-w-md truncate text-muted-foreground" title={v.description ?? ''}>
              {v.description ?? ''}
            </td>
            <td>{statusLabel[v.status]}</td>
            <td>{isImported(v) ? importedLabel : buildLabel(v)}</td>
            <td>{v.builtAt === null ? '—' : formatDateTime(v.builtAt)}</td>
            <td>{v.boundSessions}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function WorkflowRow({
  workflow,
  variants,
}: {
  workflow: WorkflowRecord;
  variants: (Variant & { boundSessions: number })[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <Fragment>
      <tr className="border-b" data-testid={`workflow-row-${workflow.id}`}>
        <td className="py-2">
          <span className="flex items-center gap-1">
            <Button
              size="icon-xs"
              variant="ghost"
              aria-expanded={open}
              aria-label={`${open ? '收起' : '展开'} ${workflow.name} 的 variant`}
              onClick={() => {
                setOpen(!open);
              }}
            >
              {open ? <ChevronDown /> : <ChevronRight />}
            </Button>
            <Link
              className="font-medium underline-offset-4 hover:underline"
              to={`/workflows/${workflow.id}`}
            >
              {workflow.name}
            </Link>
            {workflow.builtin && <span className="ml-1 text-xs text-muted-foreground">内置</span>}
          </span>
        </td>
        <td className="max-w-md truncate text-muted-foreground" title={workflow.description ?? ''}>
          {workflow.description ?? ''}
        </td>
        <td className="font-mono">/{workflow.id}</td>
        <td>{evalKindLabel(workflow.evalKind)}</td>
        <td>{workflow.definition.stages.length}</td>
        <td>{workflow.variants}</td>
      </tr>
      {open && (
        <tr className="border-b bg-muted/30" data-testid={`workflow-variants-${workflow.id}`}>
          <td colSpan={6} className="px-8 py-2">
            <VariantRows variants={variants} />
          </td>
        </tr>
      )}
    </Fragment>
  );
}

// Contracts 16.7、18.3：Workflows 列表与新建（从空白新建，或用 Codex 生成）
export function WorkflowsPage() {
  const list = useQuery(workflowsQuery);
  const variants = useQuery(variantsQuery);
  const [creating, setCreating] = useState<'blank' | 'codex' | null>(null);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageShell
          title="Workflows"
          description="workflow 是一个入口命令加一串小阶段；variant 是它的实例。内置的 lfg、ic 只读（描述可改），新的 workflow 从空白新建。"
        />
        <div className="flex gap-2">
          <Button
            onClick={() => {
              setCreating('blank');
            }}
          >
            <Plus />
            从空白新建
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
      {creating === 'blank' && (
        <BlankWorkflowForm
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
      {(list.isError || variants.isError) && (
        <Alert variant="destructive">
          <AlertTitle>无法读取 workflow 列表</AlertTitle>
          <AlertDescription>{(list.error ?? variants.error)?.message}</AlertDescription>
        </Alert>
      )}
      {list.data !== undefined && (
        <table className="w-full text-sm" data-testid="workflows-table">
          <thead className="text-left text-muted-foreground">
            <tr className="border-b">
              <th className="py-2 font-medium">名字</th>
              <th className="font-medium">描述</th>
              <th className="font-medium">入口命令</th>
              <th className="font-medium">评测类型</th>
              <th className="font-medium">小阶段数</th>
              <th className="font-medium">variant 数</th>
            </tr>
          </thead>
          <tbody>
            {list.data.map((w) => (
              <WorkflowRow
                key={w.id}
                workflow={w}
                variants={(variants.data ?? []).filter((v) => v.workflowId === w.id)}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
