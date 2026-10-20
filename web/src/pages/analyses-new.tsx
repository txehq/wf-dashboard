import {
  keepPreviousData,
  type UseQueryResult,
  useMutation,
  useQuery,
} from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { EngineChoice } from '@/components/engine-choice';
import { EngineLogo } from '@/components/live/live-identity';
import { ImportColumns } from '@/components/sessions/import-columns';
import { Button } from '@/components/ui/button';
import {
  type AnalysisEngine,
  type AnalysisScope,
  analysisOptionsQuery,
  createAnalysis,
  type ScopeSession,
  scopeQuery,
} from '@/lib/analyses-api';
import {
  configBlock,
  engineBlock,
  type Picked,
  pickedScope,
  pickLock,
  preselection,
  toggledPicks,
} from '@/lib/analysis-pick';
import { useSessionEngine } from '@/lib/session-view';
import type { SessionEngine } from '@/lib/sessions-api';

const SESSION_ORDER = ['claude', 'codex'] as const;
const engineNames = { claude: 'Claude Code', codex: 'Codex' } as const;

// Contracts 27：新建分析。左边直接从磁盘选择 session（与 Sessions 导入区相同的三列），右边固定的设置栏。
// 一次分析只能是同一个配置、同一种引擎：已选了之后第一列的其他配置与另一种引擎灰显。
// 从 Sessions、Runs、session 详情带着选择进入时已选好并选定它们所在的配置（?picked=、?batch=、?sessions=）
export function AnalysisNewPage() {
  const [params] = useSearchParams();
  const [initial] = useState(() => preselection(params));
  const [storedEngine] = useSessionEngine();
  const [engine, setEngine] = useState<SessionEngine>(storedEngine);
  const [picked, setPicked] = useState<Picked[]>(() =>
    initial !== null && initial !== 'missing' && 'sessions' in initial
      ? initial.sessions.map((id) => ({ id, disk: null }))
      : [],
  );
  // ?batch=：batch 的全部 run 的 session
  const batch = initial !== null && initial !== 'missing' && 'batch' in initial ? initial : null;
  const batchScope = useQuery({
    ...scopeQuery(batch ?? { batch: '' }),
    enabled: batch !== null,
  });
  const [seeded, setSeeded] = useState(false);
  if (!seeded && batchScope.data !== undefined) {
    setSeeded(true);
    setPicked(batchScope.data.sessions.map((s) => ({ id: s.id, disk: null })));
  }
  const scope = useQuery({
    ...scopeQuery(pickedScope(picked)),
    enabled: picked.length > 0,
    placeholderData: keepPreviousData,
  });
  const scoped = new Map((scope.data?.sessions ?? []).map((s) => [s.id, s]));
  const lock = pickLock(picked, scoped);
  // 带着选择进入时切到它们的引擎
  if (lock !== null && lock.engine !== engine) setEngine(lock.engine);
  const pickedIds = new Set(picked.map((p) => p.id));

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="text-2xl font-semibold">New analysis</h1>
          <EngineChoice
            value={engine}
            onChange={setEngine}
            order={SESSION_ORDER}
            label="视图"
            blocked={(e) => engineBlock(e, lock)}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          左边从磁盘选择 session，右边设置后开始分析。一次分析只能选同一个配置、同一种引擎的
          session：本机配置的，或某一个 variant 的。
        </p>
      </header>
      {initial === 'missing' && (
        <p role="alert" className="text-sm text-destructive">
          这个标签页中没有带过来的 session（它们只保存在打开这个页面的标签页中），在左边重新选择。
        </p>
      )}
      {batchScope.isError && (
        <p role="alert" className="text-sm text-destructive">
          读取 batch 的 session 失败：{batchScope.error.message}
        </p>
      )}
      <div className="grid grid-cols-[minmax(0,1fr)_300px] items-start gap-4 2xl:grid-cols-[minmax(0,1fr)_22rem]">
        <ImportColumns
          engine={engine}
          mode="pick"
          className="h-[calc(100svh-11rem)] min-h-96 grid-cols-[minmax(9rem,1fr)_minmax(10rem,1.2fr)_minmax(19rem,2.6fr)]"
          pick={{
            has: (s) => pickedIds.has(s.id),
            onChange: (list, want, place) => {
              setPicked((prev) =>
                toggledPicks(prev, list, want, {
                  engine,
                  config: place.config,
                  project: place.project,
                }),
              );
            },
            blocked: (c) => configBlock(c, lock),
            config: lock?.config ?? null,
          }}
        />
        <SettingsPanel
          picked={picked}
          scoped={scoped}
          scope={picked.length === 0 ? undefined : scope}
          onRemove={(id) => {
            setPicked((prev) => prev.filter((p) => p.id !== id));
          }}
          onClear={() => {
            setPicked([]);
          }}
        />
      </div>
    </div>
  );
}

// 右栏一项的标题与项目：从磁盘选的立即有，带着选择进入的读到范围之后才有
function itemText(p: Picked, s: ScopeSession | undefined) {
  if (p.disk !== null) return { title: p.disk.title, project: p.disk.project, known: true };
  return { title: s?.title ?? null, project: s?.project ?? null, known: s !== undefined };
}

// 右边固定的设置栏：已选的 session（可以移除与清空）、所在的配置与范围的检查结果、分析方法、引擎与模型、开始分析
function SettingsPanel({
  picked,
  scoped,
  scope,
  onRemove,
  onClear,
}: {
  picked: Picked[];
  scoped: ReadonlyMap<string, ScopeSession>;
  scope: UseQueryResult<AnalysisScope> | undefined;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  const navigate = useNavigate();
  const options = useQuery(analysisOptionsQuery);
  const [engine, setEngine] = useState<AnalysisEngine>('claude');
  const [models, setModels] = useState<Partial<Record<AnalysisEngine, string>>>({});
  const model = models[engine] ?? options.data?.defaults[engine] ?? '';
  const [chosenVariant, setChosenVariant] = useState('');
  const analysisVariantId =
    chosenVariant === '' ? (options.data?.defaults.analysisVariantId ?? '') : chosenVariant;
  const create = useMutation({
    mutationFn: () =>
      createAnalysis({
        ...pickedScope(picked),
        engine,
        model: model.trim(),
        analysisVariantId,
      }),
    onSuccess: (created) => {
      void navigate(`/analyses/${created.id}`);
    },
  });
  const s = scope?.data;
  // 范围是不是当前的选择（选择改了、新的范围还没读到时不能开始）
  const current =
    s !== undefined && !(scope?.isPlaceholderData ?? false) && s.sessions.length === picked.length;
  const toRead = s?.sessions.filter((x) => !x.inDashboard).length ?? 0;

  return (
    <aside
      aria-label="分析设置"
      className="sticky top-8 flex max-h-[calc(100svh-4rem)] flex-col rounded-lg border p-4"
      data-testid="analysis-settings"
    >
      <form
        className="flex min-h-0 flex-1 flex-col gap-4"
        aria-label="新建分析"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold" data-testid="picked-count">
            已选 {picked.length} 个
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            disabled={picked.length === 0}
            data-testid="picked-clear"
            onClick={onClear}
          >
            清空
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={
              !current ||
              s.problem !== null ||
              model.trim() === '' ||
              analysisVariantId === '' ||
              create.isPending
            }
          >
            {create.isPending ? '正在开始…' : '开始分析'}
          </Button>
        </div>
        {create.isError && (
          <p role="alert" className="text-sm text-destructive">
            {create.error.message}
          </p>
        )}
        {scope?.isError === true && (
          <p role="alert" className="text-sm text-destructive">
            读取范围失败：{scope.error.message}
          </p>
        )}
        {picked.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            在左边点一个配置与项目，勾选其中的 session。
          </p>
        ) : (
          s !== undefined && (
            <div className="flex flex-col gap-1.5 text-sm" data-testid="scope-check">
              {s.engine !== null && s.config !== null && (
                <p className="flex items-center gap-1.5" data-testid="scope-config">
                  <EngineLogo engine={s.engine} className="size-4 shrink-0" />
                  <span className="truncate">
                    {engineNames[s.engine]} · {s.config.label}
                  </span>
                </p>
              )}
              {s.problem !== null ? (
                <p role="alert" className="text-destructive" data-testid="scope-problem">
                  {s.problem}
                </p>
              ) : s.local ? (
                <p className="text-muted-foreground" data-testid="scope-local">
                  本机配置的 session：各个方面只分析 session 本身，最后只写报告，没有 skill
                  的修改建议。
                </p>
              ) : (
                s.variant !== null && (
                  <p className="text-muted-foreground">
                    按 variant{' '}
                    <Link
                      className="text-foreground underline"
                      to={`/variants/${s.variant.id}`}
                      data-testid="scope-variant"
                    >
                      {s.variant.name}
                    </Link>{' '}
                    的 skill 分析，可以把修改建议另存为新的 variant。
                  </p>
                )
              )}
              {s.problem === null && toRead > 0 && (
                <p className="text-muted-foreground" data-testid="scope-read-in">
                  其中 {toRead} 个还不在 dashboard 中，开始时读入，不加进 Sessions 的管理表格。
                </p>
              )}
            </div>
          )
        )}
        <div className="flex shrink-0 flex-col gap-3 border-t pt-4">
          <label className="flex flex-col gap-1 text-sm font-medium">
            分析方法
            <select
              aria-label="分析方法"
              data-testid="analysis-variant"
              className="h-9 w-full rounded-md border bg-background px-2 text-sm font-normal"
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
              workflow{' '}
              <Link className="underline" to="/workflows/session-analysis">
                session-analysis
              </Link>{' '}
              的 variant，派生并构建后可以在这里选。
            </span>
          </label>
          <div className="flex flex-col gap-1 text-sm font-medium">
            引擎
            <EngineChoice
              value={engine}
              onChange={setEngine}
              order={['claude', 'codex']}
              label="分析的引擎"
            />
          </div>
          <label className="flex flex-col gap-1 text-sm font-medium">
            模型
            <input
              aria-label="模型"
              className="h-9 w-full rounded-md border bg-background px-3 font-mono text-sm font-normal"
              value={model}
              onChange={(e) => {
                setModels({ ...models, [engine]: e.target.value });
              }}
            />
            <span className="text-xs font-normal text-muted-foreground">
              {engine === 'claude' ? '默认为设置中的 judge' : '默认取 ~/.codex/config.toml'}
            </span>
          </label>
        </div>
        {picked.length > 0 && (
          <ul
            className="-mx-1 flex min-h-16 flex-1 flex-col overflow-y-auto border-t pt-2 text-sm"
            data-testid="picked-list"
          >
            {picked.map((p) => {
              const text = itemText(p, scoped.get(p.id));
              const title = text.known ? (text.title ?? '（没有用户消息）') : '正在读取…';
              return (
                <li
                  key={p.id}
                  className="flex items-start gap-1 rounded px-1 py-1.5 hover:bg-muted/60"
                  data-testid="picked-item"
                  data-session={p.id}
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium" title={title}>
                      {title}
                    </p>
                    <p
                      className="truncate font-mono text-xs text-muted-foreground"
                      title={`${text.project ?? ''} · ${p.id}`}
                    >
                      {text.project ?? '—'} · {p.id.slice(0, 8)}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-7 shrink-0"
                    aria-label={`移除 ${title}`}
                    onClick={() => {
                      onRemove(p.id);
                    }}
                  >
                    <X />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </form>
    </aside>
  );
}
