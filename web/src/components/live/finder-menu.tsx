import { useMutation } from '@tanstack/react-query';
import { ChevronDown, FolderOpen } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { Button } from '@/components/ui/button';
import { openInFinder, type OpenTarget } from '@/lib/open-api';

// "Open in Finder" in the toolbar: one icon button lists this item's directories instead of one button each
export function FinderMenu({ items }: { items: { label: string; target: OpenTarget }[] }) {
  const open = useMutation({ mutationFn: openInFinder });
  return (
    <span className="inline-flex items-center gap-2">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            size="sm"
            variant="outline"
            aria-label="Open in Finder"
            title="Open in Finder"
            data-testid="finder-menu"
          >
            <FolderOpen />
            <ChevronDown />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            className="z-[60] min-w-40 rounded-md border bg-background p-1 shadow-md"
          >
            <DropdownMenu.Label className="px-2 py-1 text-xs text-muted-foreground">
              Open in Finder
            </DropdownMenu.Label>
            {items.map((item) => (
              <DropdownMenu.Item
                key={item.target.kind}
                data-testid={`open-${item.target.kind}`}
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted"
                onSelect={() => {
                  open.mutate(item.target);
                }}
              >
                {item.label}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {open.isError && (
        <span role="alert" className="text-xs text-destructive">
          {open.error.message}
        </span>
      )}
    </span>
  );
}
