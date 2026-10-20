import { EngineLogo } from '@/components/live/live-identity';
import type { DraftEngine } from '@/lib/drafts-api';

const names = { codex: 'Codex', claude: 'Claude Code' } as const;

// 生成 workflow、生成 variant 与优化的引擎（Contracts 22.1）：两个并排的按钮，带各自的 logo，点击选中。
// Sessions 页面的视图切换（25.1）用同一个组件，顺序为 Claude Code、Codex。blocked 给出不能选的引擎与原因（灰显，悬停说明）
export function EngineChoice({
  value,
  onChange,
  order = ['codex', 'claude'],
  label = '引擎',
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
