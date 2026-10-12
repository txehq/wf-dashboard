import { queryOptions, useQueryClient } from '@tanstack/react-query';
import type {
  CreateLiveBody,
  LiveDetail,
  LiveSummary,
  ResumeDefaults,
  ResumeLiveBody,
} from '@wf-dashboard/server/live/views';
import { requestJson } from '@/lib/http';
import { invalidateThrottled, useLiveEvent } from '@/lib/live-events';
import type { Variant } from '@/pages/variants-api';

// 与 Contracts 第 14 节的交互 API 对应
export type { CreateLiveBody, LiveDetail, LiveSummary, ResumeDefaults, ResumeLiveBody };
export type LiveDriver = LiveSummary['driver'];

// 交互只用按当前内容构建成功的 variant
export const isBuiltVariant = (v: Variant) =>
  v.buildStatus === 'built' && v.builtHash === v.skillsHash;

export const liveListQuery = queryOptions({
  queryKey: ['live'],
  queryFn: async () => (await requestJson('GET', '/api/live')) as LiveSummary[],
});

export function liveQuery(id: string) {
  return queryOptions({
    queryKey: ['live', id],
    queryFn: async () => (await requestJson('GET', `/api/live/${id}`)) as LiveDetail,
  });
}

export function resumeDefaultsQuery(sessionId: string) {
  return queryOptions({
    queryKey: ['live', 'resume-defaults', sessionId],
    queryFn: async () =>
      (await requestJson(
        'GET',
        `/api/live/resume-defaults?sessionId=${encodeURIComponent(sessionId)}`,
      )) as ResumeDefaults,
  });
}

export async function createLive(body: CreateLiveBody): Promise<LiveDetail> {
  return (await requestJson('POST', '/api/live', body)) as LiveDetail;
}

export async function resumeLive(body: ResumeLiveBody): Promise<LiveDetail> {
  return (await requestJson('POST', '/api/live/resume', body)) as LiveDetail;
}

export async function setLiveDriver(id: string, driver: LiveDriver): Promise<LiveDetail> {
  return (await requestJson('POST', `/api/live/${id}/driver`, { driver })) as LiveDetail;
}

export async function stopLive(id: string): Promise<LiveDetail> {
  return (await requestJson('POST', `/api/live/${id}/stop`)) as LiveDetail;
}

// live.updated：刷新交互列表与各 session 的详情（['live'] 前缀下的全部查询）
export function useLiveSessionEvents() {
  const client = useQueryClient();
  useLiveEvent((type) => {
    if (type !== 'live.updated') return;
    invalidateThrottled(client, ['live'], 300);
  });
}
