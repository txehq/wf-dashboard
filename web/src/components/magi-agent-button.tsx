import { useMutation } from '@tanstack/react-query';
import { Check, ChevronDown, Plus } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useNavigate } from 'react-router';
import { EngineLogo } from '@/components/live/live-identity';
import { Button } from '@/components/ui/button';
import type { LiveDetail } from '@/lib/live-api';
import { type MagiEngine, newMagiSession, openMagi, useMagiEngine } from '@/lib/magi-api';

const engines: { value: MagiEngine; label: string }[] = [
  { value: 'codex', label: 'Codex' },
  { value: 'claude', label: 'Claude Code' },
];

// 左侧导航最上面一行右端的"Magi Agent"按钮（Contracts 23.6）：任何页面都能点，打开 Live 并选中当前会话；
// 小箭头展开菜单：选引擎（选择记在 localStorage，默认 Codex）与"新会话"
export function MagiAgentButton() {
  const navigate = useNavigate();
  const [engine, setEngine] = useMagiEngine();
  const show = (live: LiveDetail) => {
    void navigate(`/live?item=${live.id}`);
  };
  const open = useMutation({ mutationFn: openMagi, onSuccess: show });
  const fresh = useMutation({ mutationFn: newMagiSession, onSuccess: show });
  const error = open.error ?? fresh.error;
  return (
    <span className="flex flex-col items-end gap-1">
      <span className="inline-flex rounded-md border shadow-xs" data-testid="magi-agent">
        <Button
          size="sm"
          variant="ghost"
          className="h-7 rounded-r-none px-2 text-xs whitespace-nowrap"
          title={`打开 Magi Agent（${engine === 'codex' ? 'Codex' : 'Claude Code'}）`}
          disabled={open.isPending || fresh.isPending}
          data-testid="magi-agent-open"
          data-engine={engine}
          onClick={() => {
            open.mutate(engine);
          }}
        >
          Magi Agent
        </Button>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 rounded-l-none border-l px-1"
              aria-label="Magi Agent 的引擎与新会话"
              data-testid="magi-agent-menu"
            >
              <ChevronDown />
            </Button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content
              align="start"
              className="z-[60] min-w-44 rounded-md border bg-background p-1 shadow-md"
            >
              <DropdownMenu.Label className="px-2 py-1 text-xs text-muted-foreground">
                引擎
              </DropdownMenu.Label>
              <DropdownMenu.RadioGroup
                value={engine}
                onValueChange={(value) => {
                  setEngine(value === 'claude' ? 'claude' : 'codex');
                }}
              >
                {engines.map((e) => (
                  <DropdownMenu.RadioItem
                    key={e.value}
                    value={e.value}
                    data-testid="magi-engine"
                    data-engine={e.value}
                    className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted"
                  >
                    <EngineLogo engine={e.value} className="size-4" />
                    {e.label}
                    <DropdownMenu.ItemIndicator className="ml-auto">
                      <Check className="size-4" />
                    </DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
              <DropdownMenu.Separator className="my-1 h-px bg-border" />
              <DropdownMenu.Item
                data-testid="magi-new-session"
                className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-muted"
                onSelect={() => {
                  fresh.mutate(engine);
                }}
              >
                <Plus className="size-4" />
                新会话
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      </span>
      {error !== null && (
        <span role="alert" className="text-xs text-destructive">
          {error.message}
        </span>
      )}
    </span>
  );
}
