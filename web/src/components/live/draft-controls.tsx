import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Play, Save } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { Link } from 'react-router';
import { DraftProgress } from '@/components/codex-draft';
import { CodexSaveDialog } from '@/components/codex-save-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { type Draft, draftQuery, resumeDraft, retryDraft } from '@/lib/drafts-api';
import type { LiveDetail } from '@/lib/live-api';
import { invalidateThrottled, useLiveEvent } from '@/lib/live-events';
import { variantHref, variantLabel } from '@/pages/variants-api';

// Live 中设计与分析优化会话比交互项多出的部分（Contracts 17.4、22、26.1），放进交互项共用的工具栏：
// resume（接着草稿的会话）、保存，下面一行的草稿与分析，工具栏下面的准备进度、保存出的链接与出错的原文；
// Codex 与 Claude Code 相同
export interface DraftControls {
  draft: Draft | undefined;
  resume: ReactNode;
  save: ReactNode;
  meta: ReactNode;
  below: ReactNode;
}

export function useDraftControls(
  live: LiveDetail,
  onResumed: (live: LiveDetail) => void,
): DraftControls {
  const client = useQueryClient();
  const draftId = live.draftId;
  const draft = useQuery({ ...draftQuery(draftId ?? ''), enabled: draftId !== null });
  const resume = useMutation({ mutationFn: () => resumeDraft(live.id), onSuccess: onResumed });
  // 保存对话框（Contracts 17.4）：保存到哪里、名字与描述、将要保存的改动
  const [saving, setSaving] = useState(false);
  const retry = useMutation({
    mutationFn: () => retryDraft(draftId ?? ''),
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['drafts'] });
    },
  });
  // 准备的进度与状态（Contracts 17.1）
  useLiveEvent((type) => {
    if (type === 'draft.updated') invalidateThrottled(client, ['drafts'], 300);
  });
  const d = draft.data;
  const savable = d?.status === 'open' || d?.status === 'saved';
  const save = draftId !== null && (
    <>
      <Button
        size="sm"
        data-testid="codex-draft-save"
        disabled={!savable}
        title="新建 variant 或覆盖已有 variant；保存后不构建"
        onClick={() => {
          setSaving(true);
        }}
      >
        <Save />
        保存
      </Button>
      {saving && d !== undefined && (
        <CodexSaveDialog
          draft={d}
          onClose={() => {
            setSaving(false);
          }}
        />
      )}
    </>
  );
  const meta =
    draftId === null ? (
      <span>这个会话没有关联的草稿</span>
    ) : (
      <>
        <span data-testid="codex-draft-id">
          草稿 <span className="font-mono">{draftId}</span>
        </span>
        {d?.analysisId != null && (
          <Link
            className="underline"
            to={`/analyses/${d.analysisId}`}
            data-testid="codex-draft-analysis"
          >
            分析 {d.analysisId}
          </Link>
        )}
      </>
    );
  const resumeButton = live.status !== 'running' && live.process !== null && (
    <Button
      size="sm"
      variant="outline"
      data-testid="codex-resume"
      title="resume"
      disabled={resume.isPending}
      onClick={() => {
        resume.mutate();
      }}
    >
      <Play />
      <span data-toolbar-label>resume</span>
    </Button>
  );
  const below = (
    <>
      {d !== undefined && (d.status === 'preparing' || d.status === 'failed') && (
        <DraftProgress
          draft={d}
          retrying={retry.isPending}
          onRetry={() => {
            retry.mutate();
          }}
        />
      )}
      {d !== undefined && d.savedVariants.length > 0 && (
        <p className="flex flex-wrap items-center gap-x-2 text-sm" data-testid="codex-draft-saved">
          已保存：
          {d.mode !== 'variant' &&
            d.savedWorkflowId !== null &&
            (d.mode === 'workflow' || d.savedWorkflowId !== d.workflowId) && (
              <Link className="underline" to={`/workflows/${d.savedWorkflowId}`}>
                workflow /{d.savedWorkflowId}
              </Link>
            )}
          {d.savedVariants.map((v) =>
            // 已删除的只显示名字（服务端已加上「（已删除）」，Contracts 24.3）
            v.deleted ? (
              <span key={v.id}>{variantLabel(v)}</span>
            ) : (
              <Link key={v.id} className="underline" to={variantHref(v)}>
                {variantLabel(v)}
              </Link>
            ),
          )}
        </p>
      )}
      {(resume.isError || retry.isError || draft.isError) && (
        <Alert variant="destructive" data-testid="codex-draft-error">
          <AlertTitle>出错了</AlertTitle>
          <AlertDescription className="max-h-80 overflow-auto font-mono text-xs whitespace-pre-wrap">
            {(resume.error ?? retry.error ?? draft.error)?.message}
          </AlertDescription>
        </Alert>
      )}
    </>
  );
  return { draft: d, resume: resumeButton, save, meta, below };
}
