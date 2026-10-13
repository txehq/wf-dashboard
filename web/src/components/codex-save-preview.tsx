import { useQuery } from '@tanstack/react-query';
import { Save, X } from 'lucide-react';
import { Dialog } from 'radix-ui';
import { useMemo } from 'react';
import {
  countChanges,
  DiffCounts,
  DiffView,
  DiffViewTypeToggle,
  parseUnifiedDiff,
  useDiffViewType,
} from '@/components/diff';
import { Button } from '@/components/ui/button';
import { draftDiffQuery } from '@/lib/drafts-api';

// 保存前的改动预览（Contracts 21.3）：将要保存的 src/ 相对底子的 diff，确认后才保存
export function CodexSavePreview({
  draftId,
  saveLabel,
  onConfirm,
  onClose,
}: {
  draftId: string;
  saveLabel: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [viewType] = useDiffViewType();
  const diff = useQuery(draftDiffQuery(draftId));
  const files = useMemo(
    () => (diff.data?.files ?? []).flatMap((f) => parseUnifiedDiff(f.patch)),
    [diff.data],
  );
  const sources = Object.fromEntries((diff.data?.files ?? []).map((f) => [f.path, f.oldContent]));
  const total = countChanges(files.flatMap((f) => f.hunks));
  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-[60] bg-black/30" />
        <Dialog.Content
          className="fixed inset-x-[4vw] inset-y-[5vh] z-[60] flex flex-col gap-3 rounded-lg border bg-background p-4 shadow-lg"
          data-testid="codex-save-preview"
        >
          <div className="flex items-center gap-3">
            <Dialog.Title className="text-base font-semibold">保存前的改动</Dialog.Title>
            <Dialog.Description className="text-xs text-muted-foreground">
              {diff.data === undefined
                ? ''
                : diff.data.base === null
                  ? '从空白开始，没有底子，全部是新增的文件'
                  : `相对底子 ${diff.data.base.name}`}
            </Dialog.Description>
            {files.length > 0 && (
              <span className="text-xs text-muted-foreground" data-testid="codex-save-summary">
                {files.length} 个文件 <DiffCounts {...total} />
              </span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <DiffViewTypeToggle />
              <Button size="sm" variant="ghost" onClick={onClose}>
                <X />
                取消
              </Button>
              <Button
                size="sm"
                data-testid="codex-draft-confirm"
                disabled={!diff.isSuccess}
                onClick={onConfirm}
              >
                <Save />
                {saveLabel}
              </Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {diff.isPending && <p className="text-sm text-muted-foreground">正在比较…</p>}
            {diff.isError && (
              <pre role="alert" className="text-xs whitespace-pre-wrap text-destructive">
                {diff.error.message}
              </pre>
            )}
            {diff.isSuccess && files.length === 0 && (
              <p className="text-sm text-muted-foreground" data-testid="codex-save-empty">
                skill 与底子相同，没有改动。
              </p>
            )}
            <DiffView files={files} sources={sources} viewType={viewType} />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
