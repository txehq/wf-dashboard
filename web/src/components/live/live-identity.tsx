import { Icon } from '@iconify/react';
import claudeIcon from '@iconify-icons/logos/claude-icon';
import openaiIcon from '@iconify-icons/logos/openai-icon';
import { Hammer, MessagesSquare, Sparkles } from 'lucide-react';
import { Link } from 'react-router';
import type { LiveSummary } from '@/lib/live-api';
import { type PurposeFilter, purposeFilters, purposeLabel } from '@/lib/live-purpose';
import { cn } from '@/lib/utils';

// 交互项一眼能看出用途与引擎（Contracts 14.3）：左侧色带与带图标、文字的用途标签；引擎用各自的 logo。
// logo 取自 SVG Logos（Gil Barbara，CC0-1.0，@iconify-icons/logos 中每个图标单独一个模块）：Claude 的标志用品牌的
// 橙色（--engine-claude，亮色下取较深的一种），OpenAI 的标志没有填充色，跟随文字颜色，明暗主题下与底色都至少 3:1

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
        className={cn(
          'size-full fill-current',
          engine === 'claude' && '[&_path]:fill-engine-claude',
        )}
        aria-hidden
      />
    </span>
  );
}

// 每种用途的颜色（index.css 的 --purpose-* 与 --warning-*，明暗各一组）：色带、标签的底色与文字；交互为中性色
const purposeStyle: Record<Purpose, { band: string; badge: string }> = {
  interaction: {
    band: 'bg-purpose-interaction',
    badge: 'border-border bg-muted text-muted-foreground',
  },
  design: {
    band: 'bg-purpose-design',
    badge:
      'border-purpose-design-border bg-purpose-design-muted text-purpose-design-muted-foreground',
  },
  optimize: {
    band: 'bg-purpose-optimize',
    badge: 'border-warning-border bg-warning text-warning-foreground',
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
