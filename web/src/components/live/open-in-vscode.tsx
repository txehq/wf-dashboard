import { Icon } from '@iconify/react';
import vscodeIcon from '@iconify-icons/logos/visual-studio-code';
import { useMutation } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { openVscode } from '@/lib/vscode-api';

// The VS Code logo comes from SVG Logos (Gil Barbara, CC0-1.0, @iconify-icons/logos)
export function VscodeLogo({ className }: { className?: string }) {
  return <Icon icon={vscodeIcon} className={className} aria-hidden />;
}

// "Open in VS Code" in the toolbar (Contracts section 32): the user's VS Code opens the item's working directory, over
// Remote - SSH for an item on an SSH host; when that fails, the error as written beside the button
export function OpenInVscode({ liveId }: { liveId: string }) {
  const open = useMutation({ mutationFn: () => openVscode(liveId) });
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Button
        size="sm"
        variant="outline"
        title="Open in VS Code"
        aria-label="Open in VS Code"
        data-testid="open-vscode"
        onClick={() => {
          open.mutate();
        }}
      >
        <VscodeLogo />
      </Button>
      {open.isError && (
        <span
          role="alert"
          className="max-w-60 truncate text-xs text-destructive"
          title={open.error.message}
          data-testid="vscode-error"
        >
          {open.error.message}
        </span>
      )}
    </span>
  );
}
