import { useMutation } from '@tanstack/react-query';
import { FolderOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { openInFinder, type OpenTarget } from '@/lib/open-api';

export function OpenInFinder({ target, label }: { target: OpenTarget; label: string }) {
  const open = useMutation({
    mutationFn: () => openInFinder(target),
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
