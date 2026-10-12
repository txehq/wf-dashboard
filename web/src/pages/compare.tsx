import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { TaskRecord } from '@wf-dashboard/server/tasks/schema';
import { ChartNoAxesColumn } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  type CompareGrouping,
  type CompareRun,
  compareQuery,
  compareRunsQuery,
  MAX_VARIANTS,
  type SelectedVariant,
  seriesColor,
} from '@/lib/compare';
import { tasksQuery } from '@/lib/tasks';
import { cn } from '@/lib/utils';
import { type WorkflowRecord, workflowsQuery } from '@/lib/workflows-api';
import { ArtifactSideBySide } from '@/pages/compare-artifacts';
import { CostComparison } from '@/pages/compare-costs';
import { ScoreTable } from '@/pages/compare-scores';
import { SkillDiffSection } from '@/pages/compare-skills';
import { type Variant, variantLabel, variantsQuery } from '@/pages/variants-api';

interface Selection {
  // 对比范围：一个有评测类型的 workflow（Contracts 16.5），写作 workflow id
  scope: string;
  // 按 variant 分组，或按 variant 与模型分组
  groupBy: CompareGrouping;
  // 第一个是基线；slot 在选中时分配，之后不变
  variants: { id: string; slot: number }[];
  tasks: string[];
  includeIntervened: boolean;
  includeCrossRef: boolean;
  includeSourceRef: boolean;
  includeCancelled: boolean;
}

// 范围内的 variant 与 task：这个 workflow 的 variant，kind 为它的评测类型的 task
function scopeOf(
  scope: string,
  workflows: WorkflowRecord[],
  variants: Variant[],
  tasks: TaskRecord[],
) {
  const kind = workflows.find((w) => w.id === scope)?.evalKind ?? null;
  return {
    variants: variants.filter((v) => v.workflowId === scope),
    tasks: kind === null ? [] : tasks.filter((t) => t.task.kind === kind),
  };
}

// 有已评分 run 的范围（有评测类型的 workflow），按 workflow 列表的顺序（内置的 lfg、ic 在前）
function scopesOf(workflows: WorkflowRecord[], variants: Variant[], runs: CompareRun[]): string[] {
  return workflows
    .filter(
      (w) =>
        w.evalKind !== null &&
        runs.some((r) => variants.find((v) => v.id === r.variantId)?.workflowId === w.id),
    )
    .map((w) => w.id);
}

function freeSlot(taken: { slot: number }[]): number {
  for (let slot = 0; slot < MAX_VARIANTS; slot++) {
    if (!taken.some((t) => t.slot === slot)) return slot;
  }
  throw new Error(`最多同时对比 ${String(MAX_VARIANTS)} 个 variant`);
}

// 默认：第一个有已评分 run 的范围；其中有已评分 run 的 variant 按创建时间排序，没有 parent 的最早的一个作为基线；
// 范围内全部有 run 的 task。换范围时保留分组与四个开关
function defaultSelection(
  workflows: WorkflowRecord[],
  variants: Variant[],
  tasks: TaskRecord[],
  runs: CompareRun[],
  scope: string,
  keep: Pick<
    Selection,
    'groupBy' | 'includeIntervened' | 'includeCrossRef' | 'includeSourceRef' | 'includeCancelled'
  > = {
    groupBy: 'variant',
    includeIntervened: false,
    includeCrossRef: false,
    includeSourceRef: false,
    includeCancelled: false,
  },
): Selection {
  const inScope = scopeOf(scope, workflows, variants, tasks);
  const scopedRuns = runs.filter(
    (r) =>
      inScope.variants.some((v) => v.id === r.variantId) &&
      inScope.tasks.some((t) => t.task.id === r.taskId),
  );
  const graded = inScope.variants
    .filter((v) => scopedRuns.some((r) => r.variantId === v.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const baseline = graded.find((v) => v.parentId === null) ?? graded[0];
  const ordered = baseline === undefined ? [] : [baseline, ...graded.filter((v) => v !== baseline)];
  return {
    ...keep,
    scope,
    variants: ordered.slice(0, MAX_VARIANTS).map((v, slot) => ({ id: v.id, slot })),
    tasks: inScope.tasks
      .filter((t) => scopedRuns.some((r) => r.taskId === t.task.id))
      .map((t) => t.task.id),
  };
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-6 py-16 text-center">
      <ChartNoAxesColumn className="size-10 text-muted-foreground" aria-hidden />
      <p className="text-sm" data-testid="compare-empty">
        还没有已评分的 run。先在 Runs 页面发起一个 batch，运行并评分完成后就能在这里对比。
      </p>
      <Button asChild>
        <Link to="/runs">去 Runs 页面</Link>
      </Button>
    </div>
  );
}

function Section({
  title,
  id,
  children,
}: {
  title: string;
  id: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-lg font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function SelectionPanel({
  selection,
  workflows,
  variants,
  tasks,
  runs,
  onChange,
}: {
  selection: Selection;
  workflows: WorkflowRecord[];
  variants: Variant[];
  tasks: TaskRecord[];
  runs: CompareRun[];
  onChange: (s: Selection) => void;
}) {
  const scoped = scopeOf(selection.scope, workflows, variants, tasks);
  const scopedRuns = runs.filter(
    (r) =>
      scoped.variants.some((v) => v.id === r.variantId) &&
      scoped.tasks.some((t) => t.task.id === r.taskId),
  );
  const graded = scoped.variants
    .filter((v) => scopedRuns.some((r) => r.variantId === v.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const others = scoped.variants.length - graded.length;
  const gradedTasks = scoped.tasks.filter((t) => scopedRuns.some((r) => r.taskId === t.task.id));
  const inScope = (r: CompareRun) =>
    selection.variants.some((v) => v.id === r.variantId) && selection.tasks.includes(r.taskId);
  const intervenedCount = runs.filter((r) => r.humanIntervened && inScope(r)).length;
  const crossRefCount = runs.filter((r) => r.crossRunRefs.length > 0 && inScope(r)).length;
  const sourceRefCount = runs.filter((r) => r.sourceRefs.length > 0 && inScope(r)).length;
  const cancelledCount = runs.filter((r) => r.cancelled && inScope(r)).length;
  const full = selection.variants.length >= MAX_VARIANTS;

  const toggleVariant = (id: string) => {
    const selected = selection.variants.some((v) => v.id === id);
    onChange({
      ...selection,
      variants: selected
        ? selection.variants.filter((v) => v.id !== id)
        : [...selection.variants, { id, slot: freeSlot(selection.variants) }],
    });
  };
  const toggleTask = (id: string) => {
    onChange({
      ...selection,
      tasks: selection.tasks.includes(id)
        ? selection.tasks.filter((t) => t !== id)
        : // 保持 task 列表原有顺序
          gradedTasks.map((t) => t.task.id).filter((t) => t === id || selection.tasks.includes(t)),
    });
  };

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex flex-wrap gap-6">
        <fieldset className="flex flex-col gap-1" data-testid="compare-scope">
          <legend className="mb-1 text-sm font-medium">范围（一个 workflow）</legend>
          <div className="flex flex-wrap gap-3">
            {scopesOf(workflows, variants, runs).map((scope) => (
              <label key={scope} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="compare-scope"
                  checked={selection.scope === scope}
                  onChange={() => {
                    onChange(defaultSelection(workflows, variants, tasks, runs, scope, selection));
                  }}
                />
                <span className="font-mono">/{scope}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-1" data-testid="compare-group-by">
          <legend className="mb-1 text-sm font-medium">分组</legend>
          <div className="flex flex-wrap gap-3">
            {(
              [
                ['variant', '按 variant'],
                ['model', '按 variant 与模型'],
              ] as const
            ).map(([value, label]) => (
              <label key={value} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="compare-group-by"
                  value={value}
                  checked={selection.groupBy === value}
                  onChange={() => {
                    onChange({ ...selection, groupBy: value });
                  }}
                />
                {label}
              </label>
            ))}
          </div>
        </fieldset>
      </div>
      <div className="grid gap-4 lg:grid-cols-[2fr_2fr_1fr]">
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium">variant</legend>
          {graded.map((v) => {
            const picked = selection.variants.find((s) => s.id === v.id);
            const isBaseline = selection.variants[0]?.id === v.id;
            return (
              <div key={v.id} className="flex items-center gap-2 text-sm">
                <label className="flex min-w-0 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={picked !== undefined}
                    disabled={picked === undefined && full}
                    onChange={() => {
                      toggleVariant(v.id);
                    }}
                  />
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{
                      background: picked === undefined ? 'transparent' : seriesColor(picked.slot),
                    }}
                    aria-hidden
                  />
                  <span className="truncate">{variantLabel(v)}</span>
                  <span className="text-xs text-muted-foreground">
                    {runs.filter((r) => r.variantId === v.id).length} 次 run
                  </span>
                </label>
                {isBaseline ? (
                  <span className="rounded border px-1.5 text-xs">基线</span>
                ) : (
                  picked !== undefined && (
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={() => {
                        onChange({
                          ...selection,
                          variants: [picked, ...selection.variants.filter((s) => s.id !== v.id)],
                        });
                      }}
                    >
                      设为基线
                    </Button>
                  )
                )}
              </div>
            );
          })}
          {full && (
            <p className="text-xs text-muted-foreground">
              最多同时对比 {MAX_VARIANTS} 个 variant。
            </p>
          )}
          {others > 0 && (
            <p className="text-xs text-muted-foreground">
              另有 {others} 个 variant 还没有已评分的 run。
            </p>
          )}
        </fieldset>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium">task</legend>
          {gradedTasks.map((t) => (
            <label key={t.task.id} className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={selection.tasks.includes(t.task.id)}
                onChange={() => {
                  toggleTask(t.task.id);
                }}
              />
              {t.task.title}
            </label>
          ))}
        </fieldset>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium">范围</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selection.includeIntervened}
              onChange={(event) => {
                onChange({ ...selection, includeIntervened: event.target.checked });
              }}
            />
            包含有人工干预的 run
          </label>
          <p className="text-xs text-muted-foreground" data-testid="intervened-count">
            {intervenedCount === 0
              ? '选中范围内没有'
              : `选中范围内有 ${String(intervenedCount)} 次`}
          </p>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selection.includeCrossRef}
              onChange={(event) => {
                onChange({ ...selection, includeCrossRef: event.target.checked });
              }}
            />
            包含参考了其他 run 的 run
          </label>
          <p className="text-xs text-muted-foreground" data-testid="cross-ref-count">
            {crossRefCount === 0 ? '选中范围内没有' : `选中范围内有 ${String(crossRefCount)} 次`}
          </p>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selection.includeSourceRef}
              onChange={(event) => {
                onChange({ ...selection, includeSourceRef: event.target.checked });
              }}
            />
            包含读取了来源工单或仓库的 run
          </label>
          <p className="text-xs text-muted-foreground" data-testid="source-ref-count">
            {sourceRefCount === 0 ? '选中范围内没有' : `选中范围内有 ${String(sourceRefCount)} 次`}
          </p>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selection.includeCancelled}
              onChange={(event) => {
                onChange({ ...selection, includeCancelled: event.target.checked });
              }}
            />
            包含被取消的 run
          </label>
          <p className="text-xs text-muted-foreground" data-testid="cancelled-count">
            {cancelledCount === 0
              ? '选中范围内没有'
              : `选中范围内有 ${String(cancelledCount)} 次，按取消时已写出的产物评分`}
          </p>
        </fieldset>
      </div>
    </div>
  );
}

function CompareBody({
  selection,
  workflows,
  variants,
  tasks,
  runs,
}: {
  selection: Selection;
  workflows: WorkflowRecord[];
  variants: Variant[];
  tasks: TaskRecord[];
  runs: CompareRun[];
}) {
  const selectedVariants: SelectedVariant[] = selection.variants.map((s) => {
    const v = variants.find((x) => x.id === s.id);
    if (v === undefined) throw new Error(`没有 variant ${s.id}`);
    return { id: v.id, name: variantLabel(v), slot: s.slot };
  });
  const selectedTasks = scopeOf(selection.scope, workflows, variants, tasks).tasks.filter((t) =>
    selection.tasks.includes(t.task.id),
  );
  const ready = selectedVariants.length >= 1 && selectedTasks.length >= 1;
  const result = useQuery({
    ...compareQuery(
      selectedVariants.map((v) => v.id),
      selectedTasks.map((t) => t.task.id),
      selection.includeIntervened,
      selection.includeCrossRef,
      selection.includeSourceRef,
      selection.includeCancelled,
      selection.groupBy,
    ),
    enabled: ready,
    placeholderData: keepPreviousData,
  });
  if (!ready) {
    return <p className="text-sm text-muted-foreground">至少选择一个 variant 和一个 task。</p>;
  }
  if (result.isPending) return <p className="text-sm text-muted-foreground">加载中…</p>;
  if (result.isError) return <p className="text-sm text-destructive">{result.error.message}</p>;
  // 刷新期间保留上一次的结果，其中的 variant 与 task 可能还是上一组
  const raw = result.data;
  const shownVariants = selectedVariants.filter((v) => raw.variants.includes(v.id));
  const shownTasks = selectedTasks.filter((t) => raw.tasks.includes(t.task.id));
  // 按模型分组时每个 (variant, model) 是一个系列：格子与 run 的 variantId 换成系列 id，颜色按系列依次分配
  const byModel = raw.groupBy === 'model';
  const seriesId = (variantId: string, model: string | null) =>
    model === null ? variantId : `${variantId}::${model}`;
  const series: SelectedVariant[] = byModel
    ? shownVariants
        .flatMap((v) =>
          [...new Set(raw.cells.filter((c) => c.variantId === v.id).map((c) => c.model))].map(
            (model) => ({ id: seriesId(v.id, model), name: `${v.name} · ${model ?? ''}` }),
          ),
        )
        .slice(0, MAX_VARIANTS)
        .map((s, slot) => ({ ...s, slot }))
    : shownVariants;
  const data = byModel
    ? {
        ...raw,
        variants: series.map((s) => s.id),
        cells: raw.cells.map((c) => ({ ...c, variantId: seriesId(c.variantId, c.model) })),
      }
    : raw;
  const seriesRuns = byModel
    ? runs.map((r) => ({ ...r, variantId: seriesId(r.variantId, r.model) }))
    : runs;
  const intervened = new Set(runs.filter((r) => r.humanIntervened).map((r) => r.id));
  const crossRef = new Set(runs.filter((r) => r.crossRunRefs.length > 0).map((r) => r.id));
  const sourceRef = new Set(runs.filter((r) => r.sourceRefs.length > 0).map((r) => r.id));
  const cancelled = new Set(runs.filter((r) => r.cancelled).map((r) => r.id));
  const visibleRuns = seriesRuns.filter(
    (r) =>
      series.some((v) => v.id === r.variantId) &&
      shownTasks.some((t) => t.task.id === r.taskId) &&
      (data.includeIntervened || !r.humanIntervened) &&
      (data.includeCrossRef || r.crossRunRefs.length === 0) &&
      (data.includeSourceRef || r.sourceRefs.length === 0) &&
      (data.includeCancelled || !r.cancelled),
  );
  return (
    <div
      data-testid="compare-body"
      data-refreshing={result.isPlaceholderData}
      className={cn('flex flex-col gap-10', result.isPlaceholderData && 'opacity-60')}
    >
      <Section title="分数" id="compare-scores">
        <ScoreTable
          result={data}
          variants={series}
          tasks={shownTasks}
          intervened={intervened}
          crossRef={crossRef}
          sourceRef={sourceRef}
          cancelled={cancelled}
        />
      </Section>
      <Section title="产物并排" id="compare-artifacts">
        <ArtifactSideBySide tasks={shownTasks} runs={visibleRuns} variants={series} />
      </Section>
      <Section title="各阶段成本" id="compare-costs">
        <CostComparison result={data} tasks={shownTasks} variants={series} />
      </Section>
      <Section title="skill 内容 diff" id="compare-skills">
        <SkillDiffSection variants={shownVariants} />
      </Section>
    </div>
  );
}

export function ComparePage() {
  const variants = useQuery(variantsQuery);
  const tasks = useQuery(tasksQuery);
  const runs = useQuery(compareRunsQuery);
  const workflows = useQuery(workflowsQuery);
  const [selection, setSelection] = useState<Selection | null>(null);

  const header = (
    <div className="flex flex-col gap-1">
      <h1 className="text-2xl font-semibold">Compare</h1>
      <p className="text-sm text-muted-foreground">改了 skill 之后，workflow 变好了吗？</p>
    </div>
  );
  if (variants.isPending || tasks.isPending || runs.isPending || workflows.isPending) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <p className="text-sm text-muted-foreground">加载中…</p>
      </div>
    );
  }
  if (variants.isError || tasks.isError || runs.isError || workflows.isError) {
    const error = variants.error ?? tasks.error ?? runs.error ?? workflows.error;
    return (
      <div className="flex flex-col gap-6">
        {header}
        <p className="text-sm text-destructive">{error?.message}</p>
      </div>
    );
  }
  if (runs.data.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <EmptyState />
      </div>
    );
  }
  const current =
    selection ??
    defaultSelection(
      workflows.data,
      variants.data,
      tasks.data,
      runs.data,
      scopesOf(workflows.data, variants.data, runs.data)[0] ?? '',
    );
  return (
    <div className="flex flex-col gap-6">
      {header}
      <SelectionPanel
        selection={current}
        workflows={workflows.data}
        variants={variants.data}
        tasks={tasks.data}
        runs={runs.data}
        onChange={setSelection}
      />
      <CompareBody
        selection={current}
        workflows={workflows.data}
        variants={variants.data}
        tasks={tasks.data}
        runs={runs.data}
      />
    </div>
  );
}
