import { useMutation } from '@tanstack/react-query';
import { FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { requestJson } from '@/lib/http';

// "在访达中打开"的目标（Contracts 16.7）：服务端解析出已知的目录，不传任意路径
export type OpenTarget =
  | { kind: 'variant'; id: string }
  | { kind: 'live-cwd'; id: string }
  | { kind: 'live-config'; id: string };

export function OpenInFinder({ target, label }: { target: OpenTarget; label: string }) {
  const open = useMutation({
    mutationFn: () => requestJson('POST', '/api/open', { target }),
  });
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={open.isPending}
        data-testid={`open-${target.kind}`}
        onClick={() => {
          open.mutate();
        }}
      >
        <FolderOpen />
        {label}
      </Button>
      {open.isError && (
        <span role="alert" className="text-xs text-destructive">
          {open.error.message}
        </span>
      )}
    </span>
  );
}
