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
import { allVariantsQuery, type Variant, variantLabel } from '@/pages/variants-api';

interface Selection {
  // Comparison scope: one workflow with an eval type (Contracts 16.5), written as the workflow id
  scope: string;
  // Group by variant, or by variant and model
  groupBy: CompareGrouping;
  // The first is the baseline; slot is assigned on selection and then kept
  variants: { id: string; slot: number }[];
  tasks: string[];
  includeIntervened: boolean;
  includeCrossRef: boolean;
  includeSourceRef: boolean;
  includeCancelled: boolean;
}

// Variants and tasks in scope: this workflow's variants, and tasks whose kind is its eval type
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

// Scopes with graded runs (workflows with an eval type), in workflow list order (built-in lfg and ic first)
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
  throw new Error(`At most ${String(MAX_VARIANTS)} variants can be compared at once`);
}

// Default: the first scope with graded runs; its variants with graded runs sorted by creation time, the earliest without a parent as baseline;
// every task in scope that has runs. Changing scope keeps the grouping and the four switches
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
        No graded runs yet. Start a batch on the Runs page; once it has run and been graded, compare
        it here.
      </p>
      <Button asChild>
        <Link to="/runs">Go to Runs</Link>
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
        : // Keep the task list's original order
          gradedTasks.map((t) => t.task.id).filter((t) => t === id || selection.tasks.includes(t)),
    });
  };

  return (
    <div className="flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex flex-wrap gap-6">
        <fieldset className="flex flex-col gap-1" data-testid="compare-scope">
          <legend className="mb-1 text-sm font-medium">Scope (one workflow)</legend>
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
          <legend className="mb-1 text-sm font-medium">Group by</legend>
          <div className="flex flex-wrap gap-3">
            {(
              [
                ['variant', 'Variant'],
                ['model', 'Variant and model'],
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
          <legend className="mb-1 text-sm font-medium">Variants</legend>
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
                    {runs.filter((r) => r.variantId === v.id).length}{' '}
                    {runs.filter((r) => r.variantId === v.id).length === 1 ? 'run' : 'runs'}
                  </span>
                </label>
                {isBaseline ? (
                  <span className="rounded border px-1.5 text-xs">Baseline</span>
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
                      Set as baseline
                    </Button>
                  )
                )}
              </div>
            );
          })}
          {full && (
            <p className="text-xs text-muted-foreground">
              At most {MAX_VARIANTS} variants can be compared at once.
            </p>
          )}
          {others > 0 && (
            <p className="text-xs text-muted-foreground">
              {others} more {others === 1 ? 'variant has' : 'variants have'} no graded runs yet.
            </p>
          )}
        </fieldset>
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-sm font-medium">Tasks</legend>
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
          <legend className="mb-1 text-sm font-medium">Include</legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selection.includeIntervened}
              onChange={(event) => {
                onChange({ ...selection, includeIntervened: event.target.checked });
              }}
            />
            Runs with human intervention
          </label>
          <p className="text-xs text-muted-foreground" data-testid="intervened-count">
            {intervenedCount === 0
              ? 'None in the selection'
              : `${String(intervenedCount)} in the selection`}
          </p>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selection.includeCrossRef}
              onChange={(event) => {
                onChange({ ...selection, includeCrossRef: event.target.checked });
              }}
            />
            Runs that referenced other runs
          </label>
          <p className="text-xs text-muted-foreground" data-testid="cross-ref-count">
            {crossRefCount === 0
              ? 'None in the selection'
              : `${String(crossRefCount)} in the selection`}
          </p>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selection.includeSourceRef}
              onChange={(event) => {
                onChange({ ...selection, includeSourceRef: event.target.checked });
              }}
            />
            Runs that read the source ticket or repo
          </label>
          <p className="text-xs text-muted-foreground" data-testid="source-ref-count">
            {sourceRefCount === 0
              ? 'None in the selection'
              : `${String(sourceRefCount)} in the selection`}
          </p>
          <label className="mt-2 flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={selection.includeCancelled}
              onChange={(event) => {
                onChange({ ...selection, includeCancelled: event.target.checked });
              }}
            />
            Cancelled runs
          </label>
          <p className="text-xs text-muted-foreground" data-testid="cancelled-count">
            {cancelledCount === 0
              ? 'None in the selection'
              : `${String(cancelledCount)} in the selection, graded on the output written before cancelling`}
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
    if (v === undefined) throw new Error(`No variant ${s.id}`);
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
    return (
      <p className="text-sm text-muted-foreground">Select at least one variant and one task.</p>
    );
  }
  if (result.isPending) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (result.isError) return <p className="text-sm text-destructive">{result.error.message}</p>;
  // While refreshing, the previous result is kept; its variants and tasks may still be the previous set
  const raw = result.data;
  const shownVariants = selectedVariants.filter((v) => raw.variants.includes(v.id));
  const shownTasks = selectedTasks.filter((t) => raw.tasks.includes(t.task.id));
  // Grouped by model, each (variant, model) is a series: the variantId of cells and runs becomes the series id, colors assigned per series in order
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
      <Section title="Scores" id="compare-scores">
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
      <Section title="Outputs side by side" id="compare-artifacts">
        <ArtifactSideBySide tasks={shownTasks} runs={visibleRuns} variants={series} />
      </Section>
      <Section title="Cost by stage" id="compare-costs">
        <CostComparison result={data} tasks={shownTasks} variants={series} />
      </Section>
      <Section title="Skill diff" id="compare-skills">
        <SkillDiffSection variants={shownVariants} />
      </Section>
    </div>
  );
}

export function ComparePage() {
  // Includes deleted variants: their runs and grades are kept and their names show "(deleted)" (Contracts 24.3)
  const variants = useQuery(allVariantsQuery);
  const tasks = useQuery(tasksQuery);
  const runs = useQuery(compareRunsQuery);
  const workflows = useQuery(workflowsQuery);
  const [selection, setSelection] = useState<Selection | null>(null);

  const header = (
    <div className="flex flex-col gap-1">
      <h1 className="text-2xl font-semibold">Compare</h1>
      <p className="text-sm text-muted-foreground">
        Did the workflow get better after the skill change?
      </p>
    </div>
  );
  if (variants.isPending || tasks.isPending || runs.isPending || workflows.isPending) {
    return (
      <div className="flex flex-col gap-6">
        {header}
        <p className="text-sm text-muted-foreground">Loading…</p>
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
