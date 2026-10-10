import { queryOptions } from '@tanstack/react-query';
import {
  CompareResult,
  CompareRun,
  RunArtifacts,
  RunGrades,
  SkillDiff,
} from '@wf-dashboard/server/grading/schema';
import { z } from 'zod';

const ServerError = z.object({ message: z.string() });

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  const json: unknown = await response.json();
  if (!response.ok) {
    const parsed = ServerError.safeParse(json);
    throw new Error(
      parsed.success ? parsed.data.message : `${url} 返回 ${String(response.status)}`,
    );
  }
  return json;
}

export const compareRunsQuery = queryOptions({
  queryKey: ['compare', 'runs'],
  queryFn: async () => z.array(CompareRun).parse(await getJson('/api/compare/runs')),
});

export const compareQuery = (
  variants: string[],
  tasks: string[],
  includeIntervened: boolean,
  includeCrossRef: boolean,
  includeCancelled: boolean,
) =>
  queryOptions({
    queryKey: ['compare', variants, tasks, includeIntervened, includeCrossRef, includeCancelled],
    queryFn: async () => {
      const params = new URLSearchParams({
        variants: variants.join(','),
        tasks: tasks.join(','),
        includeIntervened: String(includeIntervened),
        includeCrossRef: String(includeCrossRef),
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

// 同时对比的 variant 数上限：类别色只有 8 个
export const MAX_VARIANTS = 8;

// 得分率等 0 到 1 的比例显示为百分数
export function percent(x: number, digits = 0): string {
  return `${(x * 100).toFixed(digits)}%`;
}

export const artifactLabel = {
  brief: 'Brief',
  research: 'Research',
  plan: 'Plan',
  tickets: 'Tickets',
} as const;

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
