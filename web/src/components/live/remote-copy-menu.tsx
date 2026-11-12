import { useMutation } from '@tanstack/react-query';
import { ChevronDown, Copy } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { quote } from 'shell-quote';
import { Button } from '@/components/ui/button';

// Toolbar for items on an SSH host (Contracts 31.3): replaces "Open in Finder"; copies ssh <target>
// and the working directory
export function RemoteCopyMenu({ target, cwd }: { target: string | null; cwd: string }) {
  const copy = useMutation({ mutationFn: (text: string) => navigator.clipboard.writeText(text) });
  const items =
    target === null
      ? [{ id: 'cwd', label: 'Copy working directory', text: cwd }]
      : [
          { id: 'ssh', label: `Copy ssh ${target}`, text: quote(['ssh', target]) },
          {
            id: 'ssh-cd',
            label: 'Copy ssh into working directory',
            text: `${quote(['ssh', '-t', target])} ${quote([`cd ${quote([cwd])} && exec "$SHELL" -l`])}`,
          },
          { id: 'cwd', label: 'Copy working directory', text: cwd },
        ];
  return (
    <span className="inline-flex items-center gap-2">
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <Button
            size="sm"
            variant="outline"
            aria-label="Copy ssh command and working directory"
            title="Copy ssh command and working directory"
            data-testid="remote-copy-menu"
          >
            <Copy />
            <ChevronDown />
          </Button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="start"
            className="z-[60] min-w-40 rounded-md border bg-background p-1 shadow-md"
          >
            {items.map((item) => (
              <DropdownMenu.Item
                key={item.id}
                data-testid={`copy-${item.id}`}
                className="flex cursor-pointer flex-col items-start gap-0.5 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted"
                onSelect={() => {
                  copy.mutate(item.text);
                }}
              >
                {item.label}
                <span className="max-w-96 truncate font-mono text-xs text-muted-foreground">
                  {item.text}
                </span>
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {copy.isSuccess && <span className="text-xs text-muted-foreground">Copied</span>}
      {copy.isError && (
        <span role="alert" className="text-xs text-destructive">
          {copy.error.message}
        </span>
      )}
    </span>
  );
}
