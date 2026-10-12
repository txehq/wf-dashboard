import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Copy, Plus, Save, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { tasksQuery } from '@/lib/tasks';
import { cn } from '@/lib/utils';
import { definitionYaml, parseDefinitionYaml } from '@/lib/workflow-yaml';
import {
  evalKindLabel,
  updateWorkflow,
  type WorkflowRecord,
  workflowQuery,
} from '@/lib/workflows-api';
import { VariantPanel } from '@/pages/variant-panel';
import {
  buildLabel,
  filesQuery,
  importedLabel,
  isImported,
  request,
  statusLabel,
  type Variant,
  variantHref,
  variantsQuery,
} from '@/pages/variants-api';
import { DefinitionForm, DefinitionYamlEditor } from '@/pages/workflow-config';
import { NewWorkflowForm } from '@/pages/workflows';
import { CodexDraftForm } from '@/components/codex-draft';

type ConfigTab = 'form' | 'yaml';

// 上半部分：入口命令、评测类型与小阶段的配置；表单与 YAML 编辑同一份定义，内置的只读
function ConfigSection({ workflow, variants }: { workflow: WorkflowRecord; variants: Variant[] }) {
  const client = useQueryClient();
  const [tab, setTab] = useState<ConfigTab>('form');
  const [text, setText] = useState(() => definitionYaml(workflow.definition));
  const parsed = parseDefinitionYaml(text);
  const readOnly = workflow.builtin;
  // 小阶段从这个 workflow 各 variant 的 skill 名中选；只读时不需要
  const files = useQueries({
    queries: readOnly ? [] : variants.map((v) => filesQuery(v.id)),
  });
  const skillNames = [
    ...new Set(files.flatMap((f) => f.data?.map((file) => file.path.split('/')[1] ?? '') ?? [])),
  ]
    .filter((n) => n !== '')
    .sort();
  const save = useMutation({
    mutationFn: () => {
      if (!parsed.ok) throw new Error('定义有错误，不能保存');
      return updateWorkflow(workflow.id, {
        name: parsed.definition.name,
        definition: parsed.definition,
      });
    },
    onSuccess: async (saved) => {
      // 保存后的文本是服务端定义的标准写法
      setText(definitionYaml(saved.definition));
      await client.invalidateQueries({ queryKey: ['workflows'] });
    },
  });
  const changed = text !== definitionYaml(workflow.definition);
  return (
    <section className="flex flex-col gap-3" data-testid="workflow-config">
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" className="flex gap-1 border-b">
          {(
            [
              ['form', '表单'],
              ['yaml', 'YAML'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={cn(
                '-mb-px border-b-2 border-transparent px-3 py-1.5 text-sm text-muted-foreground',
                tab === id && 'border-foreground font-medium text-foreground',
              )}
              onClick={() => {
                setTab(id);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {!readOnly && (
          <Button
            className="ml-auto"
            size="sm"
            disabled={!parsed.ok || !changed || save.isPending}
            onClick={() => {
              save.mutate();
            }}
          >
            <Save />
            {save.isPending ? '保存中…' : '保存'}
          </Button>
        )}
      </div>
      {readOnly && (
        <p className="text-sm text-muted-foreground">
          内置的 workflow 只读；要改入口或小阶段，复制为新 workflow。
        </p>
      )}
      {tab === 'form' &&
        (parsed.ok ? (
          <DefinitionForm
            definition={parsed.definition}
            skillNames={skillNames}
            readOnly={readOnly}
            onChange={(definition) => {
              setText(definitionYaml(definition));
            }}
          />
        ) : (
          <p className="text-sm text-destructive">YAML 中有错误，修正后表单才能显示。</p>
        ))}
      {tab === 'yaml' && (
        <DefinitionYamlEditor
          key={workflow.id}
          text={text}
          readOnly={readOnly}
          issues={parsed.ok ? [] : parsed.issues}
          onChange={setText}
        />
      )}
      {!parsed.ok && (
        <ul className="flex flex-col gap-1 text-sm text-destructive" data-testid="workflow-issues">
          {parsed.issues.map((issue) => (
            <li key={`${String(issue.line)}:${issue.message}`}>
              第 {issue.line} 行：{issue.message}
            </li>
          ))}
        </ul>
      )}
      {save.isError && (
        <Alert variant="destructive">
          <AlertTitle>保存失败</AlertTitle>
          <AlertDescription>{save.error.message}</AlertDescription>
        </Alert>
      )}
      {save.isSuccess && !changed && (
        <p className="text-sm text-muted-foreground" data-testid="workflow-saved">
          已保存。
        </p>
      )}
    </section>
  );
}

// 从 txe-workflow 的 commit 导入一个基线，属于这个 workflow
function ImportBaseline({ workflowId }: { workflowId: string }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [commit, setCommit] = useState('');
  const create = useMutation({
    mutationFn: () =>
      request<Variant>('POST', '/api/variants', {
        name,
        workflowId,
        ...(commit.trim() === '' ? {} : { commit: commit.trim() }),
      }),
    onSuccess: async (variant) => {
      await client.invalidateQueries({ queryKey: ['variants'] });
      await navigate(variantHref(variant));
    },
  });
  return (
    <form
      className="flex flex-wrap items-end gap-3"
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
      <Button type="submit" variant="outline" disabled={create.isPending || name.trim() === ''}>
        {create.isPending ? '导入中…' : '导入基线'}
      </Button>
      {create.isError && <p className="text-sm text-destructive">{create.error.message}</p>}
    </form>
  );
}

// 下半部分：这个 workflow 的 variant 列表；点开一个 variant 在同一页展开它的全部内容
function VariantsSection({
  workflow,
  variants,
}: {
  workflow: WorkflowRecord;
  variants: (Variant & { boundSessions: number })[];
}) {
  const client = useQueryClient();
  const [params, setParams] = useSearchParams();
  const expanded = params.get('variant');
  const [codexing, setCodexing] = useState(false);
  const derive = useMutation({
    mutationFn: ({ sourceId, name }: { sourceId: string; name: string }) =>
      request<Variant>('POST', `/api/variants/${sourceId}/derive`, { name }),
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: ['variants'] });
      setParams({ variant: created.id });
    },
  });
  const source = variants.find((v) => v.id === expanded) ?? variants[0];
  return (
    <section className="flex flex-col gap-3" data-testid="workflow-variants">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">variant</h2>
        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            disabled={source === undefined || derive.isPending}
            title={source === undefined ? undefined : `从 ${source.name} 派生`}
            onClick={() => {
              if (source === undefined) return;
              const name = window.prompt(`新 variant 名称（从 ${source.name} 派生）`, '');
              if (name !== null && name.trim() !== '') {
                derive.mutate({ sourceId: source.id, name: name.trim() });
              }
            }}
          >
            <Plus />
            新建 variant
          </Button>
          <Button
            size="sm"
            variant="outline"
            data-testid="codex-variant-toggle"
            onClick={() => {
              setCodexing(!codexing);
            }}
          >
            <Sparkles />用 Codex 生成 variant
          </Button>
        </div>
      </div>
      {codexing && (
        <CodexDraftForm
          mode="variant"
          workflowId={workflow.id}
          onCancel={() => {
            setCodexing(false);
          }}
        />
      )}
      {derive.isError && <p className="text-sm text-destructive">{derive.error.message}</p>}
      <ImportBaseline workflowId={workflow.id} />
      {variants.length === 0 ? (
        <p className="text-sm text-muted-foreground">这个 workflow 还没有 variant。</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr className="border-b">
              <th className="py-2 font-medium">名字</th>
              <th className="font-medium">状态</th>
              <th className="font-medium">构建</th>
              <th className="font-medium">构建时间</th>
              <th className="font-medium">绑定的 session</th>
            </tr>
          </thead>
          <tbody>
            {variants.map((v) => (
              <tr
                key={v.id}
                className={cn('border-b', v.id === expanded && 'bg-accent')}
                data-testid={`variant-row-${v.name}`}
              >
                <td className="py-2">
                  <button
                    type="button"
                    className="font-medium underline-offset-4 hover:underline"
                    aria-expanded={v.id === expanded}
                    onClick={() => {
                      setParams(v.id === expanded ? {} : { variant: v.id });
                    }}
                  >
                    {v.name}
                  </button>
                </td>
                <td>{statusLabel[v.status]}</td>
                <td>{isImported(v) ? importedLabel : buildLabel(v)}</td>
                <td>{v.builtAt === null ? '—' : new Date(v.builtAt).toLocaleString()}</td>
                <td>{v.boundSessions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {expanded !== null && variants.some((v) => v.id === expanded) && (
        <VariantPanel key={expanded} id={expanded} />
      )}
    </section>
  );
}

// 有评测类型时列出可用的 task
function TasksSection({ workflow }: { workflow: WorkflowRecord }) {
  const tasks = useQuery(tasksQuery);
  if (workflow.evalKind === null) return null;
  const kind = workflow.evalKind;
  const available = (tasks.data ?? []).filter((t) => t.task.kind === kind);
  return (
    <section className="flex flex-col gap-2" data-testid="workflow-tasks">
      <h2 className="text-lg font-semibold">可用的 task（/{kind}）</h2>
      {tasks.isError && <p className="text-sm text-destructive">{tasks.error.message}</p>}
      <ul className="flex flex-col gap-1 text-sm">
        {available.map((t) => (
          <li key={t.task.id}>
            <Link className="underline-offset-4 hover:underline" to={`/tasks/${t.task.id}`}>
              {t.task.title}
            </Link>
            <span className="ml-2 font-mono text-xs text-muted-foreground">{t.task.id}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Contracts 16.7：Workflow 页面（一页）
export function WorkflowPage() {
  const { id } = useParams();
  if (id === undefined) throw new Error('路由缺少 workflow id');
  const workflow = useQuery(workflowQuery(id));
  const variants = useQuery(variantsQuery);
  const [copying, setCopying] = useState(false);
  if (workflow.isPending || variants.isPending) {
    return <p className="text-sm text-muted-foreground">加载中…</p>;
  }
  if (workflow.isError || variants.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>无法读取 workflow</AlertTitle>
        <AlertDescription>{(workflow.error ?? variants.error)?.message}</AlertDescription>
      </Alert>
    );
  }
  const w = workflow.data;
  const own = variants.data.filter((v) => v.workflowId === w.id);
  return (
    <div className="flex flex-col gap-6">
      <Button asChild variant="ghost" className="w-fit">
        <Link to="/workflows">
          <ArrowLeft />
          全部 workflow
        </Link>
      </Button>
      <div className="flex flex-wrap items-start gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold">{w.name}</h1>
          <p className="text-sm text-muted-foreground" data-testid="workflow-summary">
            入口 <span className="font-mono text-foreground">/{w.id}</span> · 评测类型{' '}
            {evalKindLabel(w.evalKind)}
            {w.copiedFrom !== null && <> · 复制自 {w.copiedFrom}</>}
          </p>
        </div>
        {w.builtin && (
          <Button
            className="ml-auto"
            variant="outline"
            onClick={() => {
              setCopying(true);
            }}
          >
            <Copy />
            复制为新 workflow
          </Button>
        )}
      </div>
      {copying && (
        <NewWorkflowForm
          initialVariantId={own[0]?.id}
          onCancel={() => {
            setCopying(false);
          }}
        />
      )}
      <ConfigSection key={w.id} workflow={w} variants={own} />
      <VariantsSection workflow={w} variants={own} />
      <TasksSection workflow={w} />
    </div>
  );
}
