import { Icon } from '@iconify/react';
import claudeIcon from '@iconify-icons/logos/claude-icon';
import openaiIcon from '@iconify-icons/logos/openai-icon';
import { Hammer, MessagesSquare, Network, Sparkles } from 'lucide-react';
import { Link } from 'react-router';
import { MagiRobot } from '@/components/magi-robot';
import type { LiveSummary } from '@/lib/live-api';
import { type PurposeFilter, purposeFilters, purposeLabel } from '@/lib/live-purpose';
import { cn } from '@/lib/utils';

// An interaction item's purpose and engine are visible at a glance (Contracts 14.3): a color band on
// the left and a purpose tag with icon and text; engines use their own logos. Logos come from SVG Logos
// (Gil Barbara, CC0-1.0, one module per icon in @iconify-icons/logos): the Claude logo uses the brand
// orange (--engine-claude, a darker shade in light mode); the OpenAI logo has no fill and follows the
// text color, at least 3:1 against the background in both themes

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

// Color of each purpose (--purpose-* and --warning-* in index.css, one set per theme): band, tag
// background and text; interaction is neutral
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
  orca: {
    band: 'bg-purpose-orca',
    badge: 'border-purpose-orca-border bg-purpose-orca-muted text-purpose-orca-muted-foreground',
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
  orca: Network,
} as const;

// Icon-only purpose mark (when the Live list collapses to a strip, Contracts 26.1); the name is in the tooltip
export function PurposeIcon({ live, className }: { live: LiveSummary; className: string }) {
  if (live.purpose === 'agent') return <MagiRobot className={className} label="Magi Agent" />;
  const IconOf = purposeIcon[live.purpose];
  return <IconOf className={className} aria-label={purposeLabel(live)} />;
}

// Purpose tag: icon plus text (Magi Agent uses its little robot); optimize items link to their analysis
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
        title={`View analysis ${live.analysisId}`}
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

// Purpose filter above the list: one select whose options show the item count per purpose, one row
// above the 15rem-wide list
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
      Filter
      <select
        aria-label="Filter by purpose"
        className="h-7 min-w-0 flex-1 rounded-md border bg-background px-1.5 text-xs text-foreground"
        data-testid="live-purpose-filter"
        value={value}
        onChange={(event) => {
          const next = purposeFilters.find((f) => f.value === event.target.value);
          if (next === undefined) throw new Error(`Unknown purpose filter: ${event.target.value}`);
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
