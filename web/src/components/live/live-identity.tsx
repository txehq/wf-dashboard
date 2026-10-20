import { Icon } from '@iconify/react';
import claudeIcon from '@iconify-icons/logos/claude-icon';
import openaiIcon from '@iconify-icons/logos/openai-icon';
import { Hammer, MessagesSquare, Sparkles } from 'lucide-react';
import { Link } from 'react-router';
import { MagiRobot } from '@/components/magi-robot';
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
  agent: {
    band: 'bg-purpose-agent',
    badge: 'border-purpose-agent-border bg-purpose-agent-muted text-purpose-agent-muted-foreground',
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

const purposeIcon = {
  interaction: MessagesSquare,
  design: Hammer,
  optimize: Sparkles,
} as const;

// 只有图标的用途标志（Live 左侧列表收成窄条时，Contracts 26.1）；名字在悬停提示中
export function PurposeIcon({ live, className }: { live: LiveSummary; className: string }) {
  if (live.purpose === 'agent') return <MagiRobot className={className} label="Magi Agent" />;
  const IconOf = purposeIcon[live.purpose];
  return <IconOf className={className} aria-label={purposeLabel(live)} />;
}

// 用途标签：图标加文字（Magi Agent 用它的小机器人）；优化的项链接到对应的分析
export function PurposeBadge({ live }: { live: LiveSummary }) {
  const className = cn(
    'inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-xs font-medium',
    purposeStyle[live.purpose].badge,
  );
  let icon;
  if (live.purpose === 'agent') icon = <MagiRobot className="size-3" />;
  else {
    const IconOf = purposeIcon[live.purpose];
    icon = <IconOf className="size-3" aria-hidden />;
  }
  const content = (
    <>
      {icon}
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

// 列表上方的用途筛选：一个下拉选择，每个选项带这种用途的项数，在 15rem 宽的列表上方占一行
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
    <label className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
      筛选
      <select
        aria-label="按用途筛选"
        className="h-7 min-w-0 flex-1 rounded-md border bg-background px-1.5 text-xs text-foreground"
        data-testid="live-purpose-filter"
        value={value}
        onChange={(event) => {
          const next = purposeFilters.find((f) => f.value === event.target.value);
          if (next === undefined) throw new Error(`未知的用途筛选：${event.target.value}`);
          onChange(next.value);
        }}
      >
        {purposeFilters.map((f) => (
          <option key={f.value} value={f.value}>
            {f.label} {counts[f.value]}
          </option>
        ))}
      </select>
    </label>
  );
}
