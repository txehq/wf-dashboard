import { EngineLogo } from '@/components/live/live-identity';
import type { DraftEngine } from '@/lib/drafts-api';

const names = { codex: 'Codex', claude: 'Claude Code' } as const;

// The engine for generating a workflow or variant and for optimizing (Contracts 22.1): two side-by-side buttons with
// their logos. The Sessions view switch (25.1) uses the same component, ordered Claude Code, Codex. blocked gives the
// engines that cannot be chosen and why (greyed out, explained on hover)
export function EngineChoice({
  value,
  onChange,
  order = ['codex', 'claude'],
  label = 'Engine',
  blocked = () => null,
}: {
  value: DraftEngine;
  onChange: (engine: DraftEngine) => void;
  order?: readonly DraftEngine[];
  label?: string;
  blocked?: (engine: DraftEngine) => string | null;
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="flex w-fit rounded-md border p-0.5"
      data-testid="engine-choice"
      data-engine={value}
    >
      {order.map((engine) => {
        const reason = blocked(engine);
        return (
          <button
            key={engine}
            type="button"
            role="radio"
            aria-checked={value === engine}
            aria-disabled={reason !== null}
            title={reason ?? undefined}
            data-engine={engine}
            className="flex h-8 items-center gap-1.5 rounded px-3 text-sm aria-checked:bg-foreground aria-checked:text-background aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            onClick={() => {
              if (reason === null) onChange(engine);
            }}
          >
            <EngineLogo engine={engine} className="size-4" />
            {names[engine]}
          </button>
        );
      })}
    </div>
  );
}
