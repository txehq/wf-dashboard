import { queryOptions, useQueryClient } from '@tanstack/react-query';
import type {
  CreateLiveBody,
  LiveDetail,
  LiveSummary,
  ResumeDefaults,
  ResumeLiveBody,
  ResumePlan,
} from '@wf-dashboard/server/live/views';
import { requestJson } from '@/lib/http';
import { invalidateThrottled, useLiveEvent } from '@/lib/live-events';
import type { Variant } from '@/pages/variants-api';

// 与 Contracts 第 14 节的交互 API 对应
export type { CreateLiveBody, LiveDetail, LiveSummary, ResumeDefaults, ResumeLiveBody, ResumePlan };
export type LiveDriver = LiveSummary['driver'];

// 交互只用按当前内容构建成功的 variant
export const isBuiltVariant = (v: Variant) =>
  v.buildStatus === 'built' && v.builtHash === v.skillsHash;

// 交互区的项；已关闭的只在 includeHidden 时列出
export function liveListQuery(includeHidden: boolean) {
  return queryOptions({
    queryKey: ['live', 'list', includeHidden],
    queryFn: async () =>
      (await requestJson(
        'GET',
        `/api/live?includeHidden=${String(includeHidden)}`,
      )) as LiveSummary[],
  });
}

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

// resume 的预检（Contracts 14.5）：对话框打开与改选配置时就说明将要做什么；variantId 为空时是本机配置
export function resumePlanQuery(sessionId: string, variantId: string | null) {
  return queryOptions({
    queryKey: ['live', 'resume-plan', sessionId, variantId],
    queryFn: async () =>
      (await requestJson(
        'GET',
        `/api/live/resume-plan?sessionId=${encodeURIComponent(sessionId)}&variantId=${encodeURIComponent(variantId ?? '')}`,
      )) as ResumePlan,
  });
}

export async function setLiveDriver(id: string, driver: LiveDriver): Promise<LiveDetail> {
  return (await requestJson('POST', `/api/live/${id}/driver`, { driver })) as LiveDetail;
}

export async function stopLive(id: string): Promise<LiveDetail> {
  return (await requestJson('POST', `/api/live/${id}/stop`)) as LiveDetail;
}

// 改名（Contracts 14.3）：空白与超过 200 字由服务端以原文报错
export async function renameLive(id: string, title: string): Promise<LiveDetail> {
  return (await requestJson('PATCH', `/api/live/${id}`, { title })) as LiveDetail;
}

// 导入到交互区（Contracts 14.5）：只建项，不启动进程；已关闭的项恢复显示
export async function importLive(sessionIds: string[]): Promise<LiveSummary[]> {
  return (await requestJson('POST', '/api/live/import', { sessionIds })) as LiveSummary[];
}

// 关闭（"×"）、恢复显示与删除（Contracts 14.5）
export async function hideLive(id: string): Promise<LiveDetail> {
  return (await requestJson('POST', `/api/live/${id}/hide`)) as LiveDetail;
}

export async function unhideLive(id: string): Promise<LiveDetail> {
  return (await requestJson('POST', `/api/live/${id}/unhide`)) as LiveDetail;
}

export async function deleteLive(id: string, confirmTitle: string): Promise<void> {
  await requestJson('DELETE', `/api/live/${id}`, { confirmTitle });
}

// Sessions 页面的"Live"按钮：已有一项（包括已关闭的）时恢复显示并使用它，否则导入建一项；返回这一项的 id
export async function openInLive(session: { id: string; liveId: string | null }): Promise<string> {
  if (session.liveId !== null) return (await unhideLive(session.liveId)).id;
  const [item] = await importLive([session.id]);
  if (item === undefined) throw new Error(`导入 session ${session.id} 没有返回项`);
  return item.id;
}

// live.updated：刷新交互列表与各 session 的详情（['live'] 前缀下的全部查询）
export function useLiveSessionEvents() {
  const client = useQueryClient();
  useLiveEvent((type) => {
    if (type !== 'live.updated') return;
    invalidateThrottled(client, ['live'], 300);
  });
}
