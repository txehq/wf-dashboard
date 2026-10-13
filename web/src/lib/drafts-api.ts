import { queryOptions } from '@tanstack/react-query';
import {
  type CreateDraftBody,
  DraftDiffView,
  type DraftStepView,
  DraftView,
  type SaveDraftBody,
  SavePlanView,
} from '@wf-dashboard/server/drafts/views';
import type { LiveDetail } from '@/lib/live-api';
import { requestJson } from '@/lib/http';

// 与 Contracts 第 17 节（用 Codex 生成 workflow 或 variant）的 API 对应
export type { CreateDraftBody, DraftStepView, SaveDraftBody };
export type Draft = DraftView;
export type SavePlan = SavePlanView;

export const draftQuery = (id: string) =>
  queryOptions({
    queryKey: ['drafts', id],
    queryFn: async () => DraftView.parse(await requestJson('GET', `/api/workflow-drafts/${id}`)),
  });

// 发起：服务端建草稿目录、装 skill、在 Live 中建 Codex 会话，返回草稿与交互项
export async function createDraft(
  body: CreateDraftBody,
): Promise<{ draft: Draft; live: LiveDetail }> {
  return (await requestJson('POST', '/api/workflow-drafts', body)) as {
    draft: Draft;
    live: LiveDetail;
  };
}

// 保存前的改动预览（Contracts 17.4、21.3）：相对被覆盖的 variant（against），不传时相对底子。
// 每次打开都重新读取，Codex 可能刚改过文件
export const draftDiffQuery = (id: string, against: string | null) =>
  queryOptions({
    queryKey: ['drafts', id, 'diff', against],
    queryFn: async () =>
      DraftDiffView.parse(
        await requestJson(
          'GET',
          `/api/workflow-drafts/${id}/diff${against === null ? '' : `?against=${encodeURIComponent(against)}`}`,
        ),
      ),
    staleTime: 0,
    gcTime: 0,
  });

// 保存对话框的内容：新 workflow 的预填，或同一 workflow 中可以覆盖的 variant；workflow.yaml 不合法时以原文报错
export const savePlanQuery = (id: string) =>
  queryOptions({
    queryKey: ['drafts', id, 'save-plan'],
    queryFn: async () =>
      SavePlanView.parse(await requestJson('GET', `/api/workflow-drafts/${id}/save-plan`)),
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

// 保存：新建 variant 或覆盖已有 variant，不构建；校验失败时服务端以原文报错
export async function saveDraft(id: string, body: SaveDraftBody): Promise<Draft> {
  return DraftView.parse(await requestJson('POST', `/api/workflow-drafts/${id}/save`, body));
}

export async function resumeCodex(liveId: string): Promise<LiveDetail> {
  return (await requestJson('POST', `/api/live/${liveId}/codex-resume`)) as LiveDetail;
}

// 重试准备：从失败的那一步接着做（Contracts 17.1）
export async function retryDraft(id: string): Promise<Draft> {
  return DraftView.parse(await requestJson('POST', `/api/workflow-drafts/${id}/retry`));
}
