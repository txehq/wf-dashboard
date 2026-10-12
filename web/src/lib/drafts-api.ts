import { queryOptions } from '@tanstack/react-query';
import { type CreateDraftBody, DraftView } from '@wf-dashboard/server/drafts/views';
import type { LiveDetail } from '@/lib/live-api';
import { requestJson } from '@/lib/http';

// 与 Contracts 第 17 节（用 Codex 生成 workflow 或 variant）的 API 对应
export type { CreateDraftBody };
export type Draft = DraftView;

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

// 保存为 workflow / variant：校验与构建失败时服务端以原文报错
export async function saveDraft(id: string): Promise<Draft> {
  return DraftView.parse(await requestJson('POST', `/api/workflow-drafts/${id}/save`));
}

export async function resumeCodex(liveId: string): Promise<LiveDetail> {
  return (await requestJson('POST', `/api/live/${liveId}/codex-resume`)) as LiveDetail;
}
