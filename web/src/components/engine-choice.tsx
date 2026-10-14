import { EngineLogo } from '@/components/live/live-identity';
import type { DraftEngine } from '@/lib/drafts-api';

const engines = [
  { engine: 'codex', name: 'Codex' },
  { engine: 'claude', name: 'Claude Code' },
] as const;

// 生成 workflow、生成 variant 与优化的引擎（Contracts 22.1）：两个并排的按钮，带各自的 logo，点击选中
export function EngineChoice({
  value,
  onChange,
}: {
  value: DraftEngine;
  onChange: (engine: DraftEngine) => void;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="引擎"
      className="flex w-fit rounded-md border p-0.5"
      data-testid="engine-choice"
      data-engine={value}
    >
      {engines.map(({ engine, name }) => (
        <button
          key={engine}
          type="button"
          role="radio"
          aria-checked={value === engine}
          data-engine={engine}
          className="flex h-8 items-center gap-1.5 rounded px-3 text-sm aria-checked:bg-foreground aria-checked:text-background"
          onClick={() => {
            onChange(engine);
          }}
        >
          <EngineLogo engine={engine} className="size-4" />
          {name}
        </button>
      ))}
    </div>
  );
}
