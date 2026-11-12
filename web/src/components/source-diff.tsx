import { useMemo } from 'react';
import {
  countChanges,
  DiffCounts,
  DiffView,
  parseUnifiedDiff,
  useDiffViewType,
} from '@/components/diff';

// Per-file changes between two src/ trees (the server sends each file's original content and unified diff), shown with the shared diff (Contracts 21.3)
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

// File count and added/removed lines, shown in the header row
export function SourceDiffSummary({ files }: { files: SourceFileDiff[] }) {
  const { parsed, total } = useSourceDiff(files);
  return (
    <span className="text-xs text-muted-foreground" data-testid="source-diff-summary">
      {parsed.length} {parsed.length === 1 ? 'file' : 'files'} <DiffCounts {...total} />
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
