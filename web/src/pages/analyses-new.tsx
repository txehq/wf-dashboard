import { useMutation, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  type AnalysisEngine,
  analysisOptionsQuery,
  bindingLabel,
  createAnalysis,
  engineLabel,
  type ScopeInput,
  scopeQuery,
} from '@/lib/analyses-api';
import { formatDateTime } from '@/lib/format';

function scopeFromParams(params: URLSearchParams): ScopeInput | null {
  const batch = params.get('batch');
  if (batch !== null && batch !== '') return { batch };
  const sessions = params.get('sessions');
  if (sessions !== null && sessions !== '') return { sessions: sessions.split(',') };
  return null;
}

// Contracts 15.2、19.2：新建分析——范围（session 或 batch）、分析用的 session-analysis variant、引擎与模型
export function AnalysisNewPage() {
  const [params] = useSearchParams();
  const input = scopeFromParams(params);
  return (
    <div className="flex max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold">New analysis</h1>
        <p className="text-sm text-muted-foreground">
          分析由 workflow{' '}
          <Link className="underline" to="/workflows/session-analysis">
            session-analysis
          </Link>{' '}
          的一个 variant
          驱动。它的每个小阶段是一个方面：流程、计划、失败、重复、token、时间、交互、产物、冲突，各由一个引擎进程按对应的
          skill 分析，每条发现都要有 session 中的原文作证据；最后综合出报告与 skill 的修改建议。
        </p>
      </header>
      {input === null ? (
        <p className="text-sm text-muted-foreground">
          在{' '}
          <Link className="underline" to="/sessions">
            Sessions
          </Link>{' '}
          中选择 session，或在{' '}
          <Link className="underline" to="/runs">
            Runs
          </Link>{' '}
          的 batch 上开始分析。
        </p>
      ) : (
        <AnalysisForm input={input} />
      )}
    </div>
  );
}

function AnalysisForm({ input }: { input: ScopeInput }) {
  const navigate = useNavigate();
  const scope = useQuery(scopeQuery(input));
  const options = useQuery(analysisOptionsQuery);
  const [engine, setEngine] = useState<AnalysisEngine>('claude');
  const [models, setModels] = useState<Partial<Record<AnalysisEngine, string>>>({});
  const model = models[engine] ?? options.data?.defaults[engine] ?? '';
  const [chosenVariant, setChosenVariant] = useState('');
  const analysisVariantId =
    chosenVariant === '' ? (options.data?.defaults.analysisVariantId ?? '') : chosenVariant;
  const create = useMutation({
    mutationFn: () => createAnalysis({ ...input, engine, model: model.trim(), analysisVariantId }),
    onSuccess: (created) => {
      void navigate(`/analyses/${created.id}`);
    },
  });

  if (scope.isPending) return <p className="text-sm text-muted-foreground">正在读取范围…</p>;
  if (scope.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        读取范围失败：{scope.error.message}
      </p>
    );
  }
  const s = scope.data;
  return (
    <form
      className="flex flex-col gap-5"
      aria-label="新建分析"
      onSubmit={(e) => {
        e.preventDefault();
        create.mutate();
      }}
    >
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-medium">
          范围：{'batch' in input ? `batch ${input.batch} 的` : ''}
          {s.sessions.length} 个 session
          {s.variant !== null && (
            <>
              ，variant{' '}
              <Link
                className="underline"
                to={`/variants/${s.variant.id}`}
                data-testid="scope-variant"
              >
                {s.variant.name}
              </Link>
            </>
          )}
        </h2>
        <ul
          className="flex flex-col divide-y rounded-lg border text-sm"
          data-testid="scope-sessions"
        >
          {s.sessions.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2">
              <Link className="font-medium underline" to={`/sessions/${x.id}`}>
                {x.title ?? '（没有用户消息）'}
              </Link>
              <span className="font-mono text-xs text-muted-foreground">
                {x.id.slice(0, 8)} · {formatDateTime(x.startedAt)}
                {x.runId !== null && ` · ${x.runId}`}
              </span>
              <span className="ml-auto text-xs">
                {x.variant === null
                  ? '未绑定'
                  : `${x.variant.name}（${x.binding === null ? '' : bindingLabel[x.binding]}）`}
              </span>
            </li>
          ))}
        </ul>
        {s.problem !== null && (
          <p role="alert" className="text-sm text-destructive" data-testid="scope-problem">
            {s.problem}
          </p>
        )}
      </section>
      <label className="flex flex-col gap-1 text-sm font-medium">
        分析方法（session-analysis 的 variant）
        <select
          aria-label="分析方法"
          data-testid="analysis-variant"
          className="h-9 w-96 rounded-md border bg-background px-2 text-sm font-normal"
          value={analysisVariantId}
          onChange={(e) => {
            setChosenVariant(e.target.value);
          }}
        >
          {analysisVariantId === '' && <option value="">没有构建通过的 variant</option>}
          {(options.data?.analysisVariants ?? []).map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
              {v.id === options.data?.defaults.analysisVariantId ? '（默认）' : ''}
            </option>
          ))}
        </select>
        <span className="text-xs font-normal text-muted-foreground">
          要改进分析方法，在 session-analysis 下派生 variant、修改 skill 并构建，这里就可以选它。
        </span>
      </label>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">引擎</legend>
        {(['claude', 'codex'] as const).map((e) => (
          <label key={e} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="engine"
              value={e}
              checked={engine === e}
              onChange={() => {
                setEngine(e);
              }}
            />
            {engineLabel[e]}
            <span className="text-xs text-muted-foreground">
              {e === 'claude' ? '默认模型为设置中的 judge' : '默认模型取 ~/.codex/config.toml'}
            </span>
          </label>
        ))}
      </fieldset>
      <label className="flex flex-col gap-1 text-sm font-medium">
        模型
        <input
          aria-label="模型"
          className="h-9 w-96 rounded-md border bg-background px-3 font-mono text-sm font-normal"
          value={model}
          onChange={(e) => {
            setModels({ ...models, [engine]: e.target.value });
          }}
        />
      </label>
      <div className="flex items-center gap-3">
        <Button
          type="submit"
          disabled={
            s.problem !== null ||
            model.trim() === '' ||
            analysisVariantId === '' ||
            create.isPending
          }
        >
          {create.isPending ? '正在开始…' : '开始分析'}
        </Button>
        {create.isError && (
          <p role="alert" className="text-sm text-destructive">
            {create.error.message}
          </p>
        )}
      </div>
    </form>
  );
}
