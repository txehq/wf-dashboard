import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX, Server } from 'lucide-react';
import { platformOfUname } from '@wf-dashboard/server/vscode/views';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { addHost, type HostCheck, type SshHostView } from '@/lib/ssh-api';
import { cn } from '@/lib/utils';

// Host marker: SSH icon and name (list items, tabs, the row under the toolbar, Contracts 31.3)
export function HostLabel({ label, className }: { label: string | null; className?: string }) {
  return (
    <span
      className={cn('inline-flex min-w-0 items-center gap-1', className)}
      data-testid="live-host"
      title={label === null ? 'Host deleted' : `SSH host ${label}`}
    >
      <Server className="size-3.5 shrink-0" aria-label="SSH" />
      <span className="truncate">{label ?? 'Deleted host'}</span>
    </span>
  );
}

// Whether a VS Code for the web server package exists for this host's platform (Contracts 32.3); without one, interactions still start
function VscodePackageItem({ platform }: { platform: string | null }) {
  const found = platform === null ? null : platformOfUname(platform);
  return (
    <li
      className="flex min-w-0 items-center gap-1.5"
      data-testid="host-vscode"
      data-found={found !== null}
    >
      {found !== null ? (
        <CircleCheck className="size-3.5 shrink-0 text-status-good" aria-label="Passed" />
      ) : (
        <CircleX className="size-3.5 shrink-0 text-destructive" aria-label="Missing" />
      )}
      <span className="font-medium whitespace-nowrap">VS Code server package</span>
      <span
        className={cn('truncate', found !== null ? 'text-muted-foreground' : 'text-destructive')}
      >
        {found ?? 'No package for this platform; cannot open in VS Code'}
      </span>
    </li>
  );
}

const TOOL_LABELS = {
  claude: 'Claude Code',
  codex: 'Codex',
  tmux: 'tmux',
  rsync: 'rsync',
  curl: 'curl',
} as const;

// Check results item by item (Contracts 31.2): the version for what passed, the output text for what is missing
export function HostCheckList({ check }: { check: HostCheck }) {
  if (!check.connected) {
    return (
      <p
        role="alert"
        className="rounded-md border border-destructive px-3 py-2 font-mono text-xs whitespace-pre-wrap text-destructive"
        data-testid="host-check-error"
      >
        {check.error}
      </p>
    );
  }
  const tools = check.tools;
  return (
    <ul className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-2" data-testid="host-check">
      <li className="flex min-w-0 items-center gap-1.5">
        <CircleCheck className="size-3.5 shrink-0 text-status-good" aria-label="Passed" />
        <span className="font-medium">Platform</span>
        <span className="truncate text-muted-foreground">{check.platform}</span>
      </li>
      <VscodePackageItem platform={check.platform} />
      <li className="flex min-w-0 items-center gap-1.5">
        <CircleCheck className="size-3.5 shrink-0 text-status-good" aria-label="Passed" />
        <span className="font-medium">HOME</span>
        <span className="truncate font-mono text-muted-foreground">{check.home}</span>
      </li>
      {tools !== null &&
        (Object.keys(TOOL_LABELS) as (keyof typeof TOOL_LABELS)[]).map((name) => {
          const tool = tools[name];
          return (
            <li
              key={name}
              className="flex min-w-0 items-center gap-1.5"
              data-testid={`host-tool-${name}`}
              data-found={tool.found}
            >
              {tool.found ? (
                <CircleCheck className="size-3.5 shrink-0 text-status-good" aria-label="Passed" />
              ) : (
                <CircleX className="size-3.5 shrink-0 text-destructive" aria-label="Missing" />
              )}
              <span className="font-medium whitespace-nowrap">{TOOL_LABELS[name]}</span>
              <span
                className={cn(
                  'truncate',
                  tool.found ? 'text-muted-foreground' : 'text-destructive',
                )}
                title={tool.found ? (tool.path ?? '') : tool.output}
              >
                {tool.found ? tool.output : `Missing: ${tool.output}`}
              </span>
            </li>
          );
        })}
      <li className="flex min-w-0 items-center gap-1.5 sm:col-span-2">
        <span className="font-medium">Entry skills</span>
        <span className="truncate text-muted-foreground" data-testid="host-entries">
          {check.entries.length === 0 ? 'None' : check.entries.map((e) => `/${e}`).join(', ')}
        </span>
      </li>
    </ul>
  );
}

// Add an SSH host (Contracts 31.1): enter a target, check it at once, save when it passes; when unreachable, show ssh's output
export function AddHostForm({
  configHosts,
  onAdded,
  autoFocus,
}: {
  // Hosts in ~/.ssh/config not added yet
  configHosts: string[];
  onAdded: (host: SshHostView) => void;
  autoFocus?: boolean;
}) {
  const client = useQueryClient();
  const [target, setTarget] = useState('');
  const adding = useMutation({
    mutationFn: addHost,
    onSuccess: async (host) => {
      setTarget('');
      await client.invalidateQueries({ queryKey: ['ssh-hosts'] });
      onAdded(host);
    },
  });
  return (
    <form
      className="flex flex-col gap-2"
      data-testid="add-host"
      onSubmit={(event) => {
        event.preventDefault();
        if (target.trim() !== '') adding.mutate(target.trim());
      }}
    >
      <div className="flex items-center gap-2">
        <Input
          aria-label="SSH host"
          placeholder="user@host or a Host from ~/.ssh/config"
          list="ssh-config-hosts"
          value={target}
          autoFocus={autoFocus}
          onChange={(event) => {
            setTarget(event.target.value);
          }}
        />
        <datalist id="ssh-config-hosts">
          {configHosts.map((h) => (
            <option key={h} value={h} />
          ))}
        </datalist>
        <Button type="submit" disabled={target.trim() === '' || adding.isPending}>
          {adding.isPending ? 'Checking…' : 'Add and check'}
        </Button>
      </div>
      {adding.isError && (
        <p
          role="alert"
          className="font-mono text-xs whitespace-pre-wrap text-destructive"
          data-testid="add-host-error"
        >
          {adding.error.message}
        </p>
      )}
    </form>
  );
}
