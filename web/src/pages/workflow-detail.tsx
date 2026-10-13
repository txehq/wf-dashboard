import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Plus, Save, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { CodexDraftForm } from '@/components/codex-draft';
import { DescriptionEditor } from '@/components/description-editor';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { StageFlow } from '@/components/workflow-flow';
import { cn } from '@/lib/utils';
import { definitionYaml, parseDefinitionYaml } from '@/lib/workflow-yaml';
import {
  evalKindLabel,
  updateWorkflow,
  type WorkflowRecord,
  workflowQuery,
} from '@/lib/workflows-api';
import {
  filesQuery,
  request,
  type Variant,
  variantHref,
  variantLabel,
  variantsQuery,
} from '@/pages/variants-api';
import { DefinitionForm, DefinitionYamlEditor } from '@/pages/workflow-config';
import { VariantRows } from '@/pages/workflows';

type ConfigTab = 'form' | 'yaml';

// 入口命令与小阶段的配置：表单与 YAML 编辑同一份定义，流程图随之更新（Contracts 18.4）；内置的只读
function ConfigSection({ workflow, variants }: { workflow: WorkflowRecord; variants: Variant[] }) {
  const client = useQueryClient();
  const [tab, setTab] = useState<ConfigTab>('form');
  const [text, setText] = useState(() => definitionYaml(workflow.definition));
  const parsed = parseDefinitionYaml(text);
  const readOnly = workflow.builtin;
  // 加入小阶段时提示这个 workflow 各 variant 中已有的 skill 名；只读时不需要
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
        description: workflow.description ?? '',
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
          内置的 workflow 只能改描述；要换入口或小阶段，从空白新建一个 workflow。
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
      <h2 className="text-lg font-semibold">小阶段流程图</h2>
      {parsed.ok ? (
        <StageFlow definition={parsed.definition} />
      ) : (
        <p className="text-sm text-muted-foreground">定义有错误，修正后显示流程图。</p>
      )}
    </section>
  );
}

// 从 txe-workflow 的 commit 导入一个基线：只属于内置的 lfg、ic（任意 workflow 的 variant 只有一组 skill）
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
      data-testid="import-baseline"
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

// 这个 workflow 的 variant 列表，名字链接到 variant 页面（Contracts 18.3）；新建 variant 是从选中的一个派生
function VariantsSection({
  workflow,
  variants,
}: {
  workflow: WorkflowRecord;
  variants: (Variant & { boundSessions: number })[];
}) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const [codexing, setCodexing] = useState(false);
  const [sourceId, setSourceId] = useState('');
  const source = variants.find((v) => v.id === sourceId) ?? variants[0];
  const derive = useMutation({
    mutationFn: ({ from, name }: { from: string; name: string }) =>
      request<Variant>('POST', `/api/variants/${from}/derive`, { name }),
    onSuccess: async (created) => {
      await client.invalidateQueries({ queryKey: ['variants'] });
      await navigate(variantHref(created));
    },
  });
  return (
    <section className="flex flex-col gap-3" data-testid="workflow-variants">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-semibold">variant</h2>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {variants.length > 0 && (
            <select
              className="h-8 rounded-md border bg-background px-2 text-sm"
              aria-label="派生自"
              value={source?.id ?? ''}
              onChange={(event) => {
                setSourceId(event.target.value);
              }}
            >
              {variants.map((v) => (
                <option key={v.id} value={v.id}>
                  {variantLabel(v)}
                </option>
              ))}
            </select>
          )}
          <Button
            size="sm"
            disabled={source === undefined || derive.isPending}
            onClick={() => {
              if (source === undefined) return;
              const name = window.prompt(`新 variant 名称（从 ${source.name} 派生）`, '');
              if (name !== null && name.trim() !== '') {
                derive.mutate({ from: source.id, name: name.trim() });
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
      {workflow.wf && <ImportBaseline workflowId={workflow.id} />}
      <VariantRows variants={variants} />
    </section>
  );
}

// Contracts 16.7、18.4：Workflow 页面
export function WorkflowPage() {
  const { id } = useParams();
  if (id === undefined) throw new Error('路由缺少 workflow id');
  const client = useQueryClient();
  const workflow = useQuery(workflowQuery(id));
  const variants = useQuery(variantsQuery);
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
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">{w.name}</h1>
        <p className="text-sm text-muted-foreground" data-testid="workflow-summary">
          入口 <span className="font-mono text-foreground">/{w.id}</span> · 评测类型{' '}
          {evalKindLabel(w.evalKind)}
        </p>
      </div>
      <DescriptionEditor
        key={w.id}
        label="描述"
        value={w.description}
        onSave={async (description) => {
          await updateWorkflow(w.id, { name: w.name, description, definition: w.definition });
          await client.invalidateQueries({ queryKey: ['workflows'] });
        }}
      />
      <ConfigSection key={w.id} workflow={w} variants={own} />
      <VariantsSection workflow={w} variants={own} />
    </div>
  );
}
