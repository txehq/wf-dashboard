import { useMemo } from 'react';
import {
  countChanges,
  DiffCounts,
  DiffView,
  parseUnifiedDiff,
  useDiffViewType,
} from '@/components/diff';

// 两份 src/ 之间逐文件的改动（服务端给出每个文件的原文与统一 diff），用共用的 diff 显示（Contracts 21.3）
export interface SourceFileDiff {
  path: string;
  oldContent: string;
  patch: string;
}

function useSourceDiff(files: SourceFileDiff[] | undefined) {
  const parsed = useMemo(() => (files ?? []).flatMap((f) => parseUnifiedDiff(f.patch)), [files]);
  const sources = useMemo(
    () => Object.fromEntries((files ?? []).map((f) => [f.path, f.oldContent])),
    [files],
  );
  return { parsed, sources, total: countChanges(parsed.flatMap((f) => f.hunks)) };
}

// 文件数与增删行数，放在标题行中
export function SourceDiffSummary({ files }: { files: SourceFileDiff[] }) {
  const { parsed, total } = useSourceDiff(files);
  return (
    <span className="text-xs text-muted-foreground" data-testid="source-diff-summary">
      {parsed.length} 个文件 <DiffCounts {...total} />
    </span>
  );
}

export function SourceDiff({ files, empty }: { files: SourceFileDiff[]; empty: string }) {
  const [viewType] = useDiffViewType();
  const { parsed, sources } = useSourceDiff(files);
  if (parsed.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="source-diff-empty">
        {empty}
      </p>
    );
  }
  return <DiffView files={parsed} sources={sources} viewType={viewType} />;
}
