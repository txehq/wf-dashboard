import { Icon } from '@iconify/react';
import claudeIcon from '@iconify-icons/logos/claude-icon';
import openaiIcon from '@iconify-icons/logos/openai-icon';
import { Hammer, MessagesSquare, Sparkles } from 'lucide-react';
import { Link } from 'react-router';
import type { LiveSummary } from '@/lib/live-api';
import { type PurposeFilter, purposeFilters, purposeLabel } from '@/lib/live-purpose';
import { cn } from '@/lib/utils';

// 交互项一眼能看出用途与引擎（Contracts 14.3）：左侧色带与带图标、文字的用途标签；引擎用各自的 logo。
// logo 取自 SVG Logos（Gil Barbara，CC0-1.0，@iconify-icons/logos 中每个图标单独一个模块）：Claude 的标志保留自己的
// 橙色，OpenAI 的标志没有填充色，跟随文字颜色，明暗主题下都清楚

type Purpose = LiveSummary['purpose'];

const engineName = { claude: 'Claude Code', codex: 'Codex' } as const;

export function EngineLogo({
  engine,
  className,
}: {
  engine: LiveSummary['engine'];
  className?: string;
}) {
  const name = engineName[engine];
  return (
    <span
      role="img"
      aria-label={name}
      title={name}
      data-testid="live-engine-logo"
      data-engine={engine}
      className={cn('inline-flex shrink-0 items-center', className)}
    >
      <Icon
        icon={engine === 'claude' ? claudeIcon : openaiIcon}
        className="size-full fill-current"
        aria-hidden
      />
    </span>
  );
}

// 每种用途的颜色：色带、标签的底色与文字；交互为中性色
const purposeStyle: Record<Purpose, { band: string; badge: string }> = {
  interaction: {
    band: 'bg-zinc-300 dark:bg-zinc-600',
    badge:
      'border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-600 dark:bg-zinc-800 dark:text-zinc-200',
  },
  design: {
    band: 'bg-violet-500 dark:bg-violet-400',
    badge:
      'border-violet-300 bg-violet-50 text-violet-800 dark:border-violet-700 dark:bg-violet-950 dark:text-violet-200',
  },
  optimize: {
    band: 'bg-amber-500 dark:bg-amber-400',
    badge:
      'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200',
  },
};

export function PurposeBand({ purpose, className }: { purpose: Purpose; className?: string }) {
  return (
    <span
      aria-hidden
      data-testid="live-purpose-band"
      data-purpose={purpose}
      className={cn('w-1 shrink-0 rounded-full', purposeStyle[purpose].band, className)}
    />
  );
}

const purposeIcon = { interaction: MessagesSquare, design: Hammer, optimize: Sparkles } as const;

// 用途标签：图标加文字；优化的项链接到对应的分析
export function PurposeBadge({ live }: { live: LiveSummary }) {
  const IconOf = purposeIcon[live.purpose];
  const className = cn(
    'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium',
    purposeStyle[live.purpose].badge,
  );
  const content = (
    <>
      <IconOf className="size-3" aria-hidden />
      {purposeLabel(live)}
    </>
  );
  if (live.purpose === 'optimize' && live.analysisId !== null) {
    return (
      <Link
        to={`/analyses/${live.analysisId}`}
        className={cn(className, 'hover:underline')}
        title={`查看分析 ${live.analysisId}`}
        data-testid="live-purpose"
        data-purpose={live.purpose}
        onClick={(event) => {
          event.stopPropagation();
        }}
      >
        {content}
      </Link>
    );
  }
  return (
    <span className={className} data-testid="live-purpose" data-purpose={live.purpose}>
      {content}
    </span>
  );
}

// 列表上方的用途筛选
export function PurposeFilterBar({
  value,
  onChange,
  counts,
}: {
  value: PurposeFilter;
  onChange: (next: PurposeFilter) => void;
  counts: Record<PurposeFilter, number>;
}) {
  return (
    <div
      role="radiogroup"
      aria-label="按用途筛选"
      className="flex rounded-md border p-0.5 text-xs"
      data-testid="live-purpose-filter"
    >
      {purposeFilters.map((f) => (
        <button
          key={f.value}
          type="button"
          role="radio"
          aria-checked={value === f.value}
          data-value={f.value}
          className="flex-1 rounded px-1.5 py-0.5 aria-checked:bg-foreground aria-checked:text-background"
          onClick={() => {
            onChange(f.value);
          }}
        >
          {f.label}
          <span className="ml-0.5 opacity-70">{counts[f.value]}</span>
        </button>
      ))}
    </div>
  );
}
