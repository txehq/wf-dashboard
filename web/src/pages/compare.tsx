import { keepPreviousData, useQuery } from '@tanstack/react-query';
import type { TaskRecord } from '@wf-dashboard/server/tasks/schema';
import { ChartNoAxesColumn } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  type CompareRun,
  compareQuery,
  compareRunsQuery,
  MAX_VARIANTS,
  type SelectedVariant,
  seriesColor,
} from '@/lib/compare';
import { tasksQuery } from '@/lib/tasks';
import { cn } from '@/lib/utils';
import { ArtifactSideBySide } from '@/pages/compare-artifacts';
import { CostComparison } from '@/pages/compare-costs';
import { ScoreTable } from '@/pages/compare-scores';
import { SkillDiffSection } from '@/pages/compare-skills';
import { type Variant, variantsQuery } from '@/pages/variants-api';

interface Selection {
  // 第一个是基线；slot 在选中时分配，之后不变
  variants: { id: string; slot: number }[];
  tasks: string[];
  includeIntervened: boolean;
}

function freeSlot(taken: { slot: number }[]): number {
  for (let slot = 0; slot < MAX_VARIANTS; slot++) {
    if (!taken.some((t) => t.slot === slot)) return slot;
  }
  throw new Error(`最多同时对比 ${String(MAX_VARIANTS)} 个 variant`);
}

// 默认：有已评分 run 的 variant 按创建时间排序，没有 parent 的最早的一个作为基线；全部有 run 的 task
function defaultSelection(variants: Variant[], tasks: TaskRecord[], runs: CompareRun[]): Selection {
  const graded = variants
    .filter((v) => runs.some((r) => r.variantId === v.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const baseline = graded.find((v) => v.parentId === null) ?? graded[0];
  const ordered = baseline === undefined ? [] : [baseline, ...graded.filter((v) => v !== baseline)];
  return {
    variants: ordered.slice(0, MAX_VARIANTS).map((v, slot) => ({ id: v.id, slot })),
    tasks: tasks.filter((t) => runs.some((r) => r.taskId === t.task.id)).map((t) => t.task.id),
    includeIntervened: false,
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
  variants,
  tasks,
  runs,
  onChange,
}: {
  selection: Selection;
  variants: Variant[];
  tasks: TaskRecord[];
  runs: CompareRun[];
  onChange: (s: Selection) => void;
}) {
  const graded = variants
    .filter((v) => runs.some((r) => r.variantId === v.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const others = variants.length - graded.length;
  const gradedTasks = tasks.filter((t) => runs.some((r) => r.taskId === t.task.id));
  const intervenedCount = runs.filter(
    (r) =>
      r.humanIntervened &&
      selection.variants.some((v) => v.id === r.variantId) &&
      selection.tasks.includes(r.taskId),
  ).length;
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
    <div className="grid gap-4 rounded-lg border p-4 lg:grid-cols-[2fr_2fr_1fr]">
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
                <span className="truncate">{v.name}</span>
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
          <p className="text-xs text-muted-foreground">最多同时对比 {MAX_VARIANTS} 个 variant。</p>
        )}
        {others > 0 && (
          <p className="text-xs text-muted-foreground">
            另有 {others} 个 variant 还没有已评分的 run。
          </p>
        )}
      </fieldset>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">task</legend>
        {(['lfg', 'ic'] as const).map((kind) => {
          const group = gradedTasks.filter((t) => t.task.kind === kind);
          if (group.length === 0) return null;
          return (
            <div key={kind} className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">/{kind}</span>
              {group.map((t) => (
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
            </div>
          );
        })}
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
        <p className="text-xs text-muted-foreground">
          {intervenedCount === 0 ? '选中范围内没有' : `选中范围内有 ${String(intervenedCount)} 次`}
        </p>
      </fieldset>
    </div>
  );
}

function CompareBody({
  selection,
  variants,
  tasks,
  runs,
}: {
  selection: Selection;
  variants: Variant[];
  tasks: TaskRecord[];
  runs: CompareRun[];
}) {
  const selectedVariants: SelectedVariant[] = selection.variants.map((s) => {
    const v = variants.find((x) => x.id === s.id);
    if (v === undefined) throw new Error(`没有 variant ${s.id}`);
    return { id: v.id, name: v.name, slot: s.slot };
  });
  const selectedTasks = ['lfg', 'ic'].flatMap((kind) =>
    tasks.filter((t) => t.task.kind === kind && selection.tasks.includes(t.task.id)),
  );
  const ready = selectedVariants.length >= 1 && selectedTasks.length >= 1;
  const result = useQuery({
    ...compareQuery(
      selectedVariants.map((v) => v.id),
      selectedTasks.map((t) => t.task.id),
      selection.includeIntervened,
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
  const data = result.data;
  const shownVariants = selectedVariants.filter((v) => data.variants.includes(v.id));
  const shownTasks = selectedTasks.filter((t) => data.tasks.includes(t.task.id));
  const intervened = new Set(runs.filter((r) => r.humanIntervened).map((r) => r.id));
  const visibleRuns = runs.filter(
    (r) =>
      shownVariants.some((v) => v.id === r.variantId) &&
      shownTasks.some((t) => t.task.id === r.taskId) &&
      (data.includeIntervened || !r.humanIntervened),
  );
  return (
    <div className={cn('flex flex-col gap-10', result.isPlaceholderData && 'opacity-60')}>
      <Section title="分数" id="compare-scores">
        <ScoreTable
          result={data}
          variants={shownVariants}
          tasks={shownTasks}
          intervened={intervened}
        />
      </Section>
      <Section title="产物并排" id="compare-artifacts">
        <ArtifactSideBySide tasks={shownTasks} runs={visibleRuns} variants={shownVariants} />
      </Section>
      <Section title="各阶段成本" id="compare-costs">
        <CostComparison result={data} tasks={shownTasks} variants={shownVariants} />
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
  const [selection, setSelection] = useState<Selection | null>(null);

  const header = (
    <div className="flex flex-col gap-1">
      <h1 className="text-2xl font-semibold">Compare</h1>
      <p className="text-sm text-muted-foreground">改了 skill 之后，workflow 变好了吗？</p>
    </div>
  );
  if (variants.isPending || tasks.isPending || runs.isPending) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <p className="text-sm text-muted-foreground">加载中…</p>
      </div>
    );
  }
  if (variants.isError || tasks.isError || runs.isError) {
    const error = variants.error ?? tasks.error ?? runs.error;
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
  const current = selection ?? defaultSelection(variants.data, tasks.data, runs.data);
  return (
    <div className="flex flex-col gap-6">
      {header}
      <SelectionPanel
        selection={current}
        variants={variants.data}
        tasks={tasks.data}
        runs={runs.data}
        onChange={setSelection}
      />
      <CompareBody
        selection={current}
        variants={variants.data}
        tasks={tasks.data}
        runs={runs.data}
      />
    </div>
  );
}
