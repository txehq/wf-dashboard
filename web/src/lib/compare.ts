import { queryOptions } from '@tanstack/react-query';
import {
  type CompareCell,
  CompareResult,
  CompareRun,
  RunArtifacts,
  RunGrades,
  SkillDiff,
} from '@wf-dashboard/server/grading/schema';
import { z } from 'zod';
import { requestJson } from '@/lib/http';

const getJson = (url: string) => requestJson('GET', url);

export const compareRunsQuery = queryOptions({
  queryKey: ['compare', 'runs'],
  queryFn: async () => z.array(CompareRun).parse(await getJson('/api/compare/runs')),
});

// Contracts 16.5: with groupBy=model each variant splits into cells by the runs' model
export type CompareGrouping = 'variant' | 'model';

export const compareQuery = (
  variants: string[],
  tasks: string[],
  includeIntervened: boolean,
  includeCrossRef: boolean,
  includeSourceRef: boolean,
  includeCancelled: boolean,
  groupBy: CompareGrouping = 'variant',
) =>
  queryOptions({
    queryKey: [
      'compare',
      variants,
      tasks,
      includeIntervened,
      includeCrossRef,
      includeSourceRef,
      includeCancelled,
      groupBy,
    ],
    queryFn: async () => {
      const params = new URLSearchParams({
        variants: variants.join(','),
        tasks: tasks.join(','),
        groupBy,
        includeIntervened: String(includeIntervened),
        includeCrossRef: String(includeCrossRef),
        includeSourceRef: String(includeSourceRef),
        includeCancelled: String(includeCancelled),
      });
      return CompareResult.parse(await getJson(`/api/compare?${params.toString()}`));
    },
  });

export const runGradesQuery = (runId: string) =>
  queryOptions({
    queryKey: ['runs', runId, 'grades'],
    queryFn: async () => RunGrades.parse(await getJson(`/api/runs/${runId}/grades`)),
    staleTime: Infinity,
  });

export const runArtifactsQuery = (runId: string) =>
  queryOptions({
    queryKey: ['compare', 'runs', runId, 'artifacts'],
    queryFn: async () => RunArtifacts.parse(await getJson(`/api/compare/runs/${runId}/artifacts`)),
    staleTime: Infinity,
  });

export const skillDiffQuery = (from: string, to: string) =>
  queryOptions({
    queryKey: ['compare', 'skill-diff', from, to],
    queryFn: async () => {
      const params = new URLSearchParams({ from, to });
      return SkillDiff.parse(await getJson(`/api/compare/skill-diff?${params.toString()}`));
    },
  });

export type {
  CompareCell,
  CompareResult,
  CompareRun,
  Distribution,
  RunGrades,
} from '@wf-dashboard/server/grading/schema';

// Which grade a cell's quality shows: rubric if any, else hidden tests if any, else acceptance criteria
export type QualityKind = 'lfg' | 'ic' | 'ic_criteria';
export function qualityKind(q: CompareCell['quality']): QualityKind {
  if (q.rubric !== null) return 'lfg';
  return q.passRate !== null ? 'ic' : 'ic_criteria';
}

// Maximum variants compared at once: there are only 8 categorical colors
export const MAX_VARIANTS = 8;

type Outcome = NonNullable<RunGrades['hiddenTests']>['detail']['outcomes'][number];

export interface OutcomeRow {
  key: string;
  file: string;
  name: string;
  left: Outcome | undefined;
  right: Outcome | undefined;
}

// Test rows for ic side by side: union of both runs' tests, left list first, right-only tests after
// (the runs' tests can differ when the task's list changed)
export function outcomeRows(left: Outcome[], right: Outcome[]): OutcomeRow[] {
  const keyOf = (o: Outcome) => `${o.file}\0${o.name}`;
  const rows = new Map<string, OutcomeRow>();
  for (const o of left) {
    rows.set(keyOf(o), { key: keyOf(o), file: o.file, name: o.name, left: o, right: undefined });
  }
  for (const o of right) {
    const row = rows.get(keyOf(o));
    if (row === undefined) {
      rows.set(keyOf(o), { key: keyOf(o), file: o.file, name: o.name, left: undefined, right: o });
    } else row.right = o;
  }
  return [...rows.values()];
}

// Ratios from 0 to 1, such as score rate, shown as percentages
export function percent(x: number, digits = 0): string {
  return `${(x * 100).toFixed(digits)}%`;
}

const artifactNames: Record<string, string> = {
  brief: 'Brief',
  research: 'Research',
  plan: 'Plan',
  tickets: 'Tickets',
};

// Rubric group display names: the four lfg groups have fixed names, others show the id
export const artifactLabel = (artifact: string) => artifactNames[artifact] ?? artifact;

// A variant's color slot on this page (0 to 7), assigned on selection and kept until deselected
export function seriesColor(slot: number): string {
  return `var(--series-${String(slot + 1)})`;
}

// Variants selected on the page; the first is the baseline
export interface SelectedVariant {
  id: string;
  name: string;
  slot: number;
}
