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

// Contracts 16.5：groupBy=model 时每个 variant 按 run 的模型分成几格
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

// 格子的质量按哪项评分显示：有 rubric 时为 rubric，否则有隐藏测试时为测试，否则为验收标准
export type QualityKind = 'lfg' | 'ic' | 'ic_criteria';
export function qualityKind(q: CompareCell['quality']): QualityKind {
  if (q.rubric !== null) return 'lfg';
  return q.passRate !== null ? 'ic' : 'ic_criteria';
}

// 同时对比的 variant 数上限：类别色只有 8 个
export const MAX_VARIANTS = 8;

type Outcome = NonNullable<RunGrades['hiddenTests']>['detail']['outcomes'][number];

export interface OutcomeRow {
  key: string;
  file: string;
  name: string;
  left: Outcome | undefined;
  right: Outcome | undefined;
}

// ic 并排的测试行：两个 run 的测试并集，左边的清单在前，只在右边出现的测试接在后面
// （task 的清单改过时两次 run 的测试可能不同）
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

// 得分率等 0 到 1 的比例显示为百分数
export function percent(x: number, digits = 0): string {
  return `${(x * 100).toFixed(digits)}%`;
}

const artifactNames: Record<string, string> = {
  brief: 'Brief',
  research: 'Research',
  plan: 'Plan',
  tickets: 'Tickets',
};

// rubric 分组的显示名：lfg 评测类型的四组用固定名字，其他分组显示 id
export const artifactLabel = (artifact: string) => artifactNames[artifact] ?? artifact;

// 一个 variant 在本页的颜色槽位（0 到 7）选中时分配，取消选择前不变
export function seriesColor(slot: number): string {
  return `var(--series-${String(slot + 1)})`;
}

// 页面上选中的 variant，第一个是基线
export interface SelectedVariant {
  id: string;
  name: string;
  slot: number;
}
