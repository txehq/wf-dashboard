import type { ReactNode } from 'react';
import { Link } from 'react-router';
import { OpenInLiveButton } from '@/components/live/open-in-live';
import { ImportProblemBadge } from '@/components/sessions/import-problem';
import { PurposeBadge, WorkflowBadges } from '@/components/sessions/workflow-badges';
import { HostLabel } from '@/components/ssh/ssh-parts';
import { tableBindingNote } from '@/lib/analyses-api';
import {
  durationBetween,
  formatCount,
  formatDateTime,
  formatDuration,
  formatInteger,
  formatUsd,
  totalTokens,
} from '@/lib/format';
import type { SessionSummary } from '@/lib/sessions-api';
import { cn } from '@/lib/utils';

// Models missing from the price table only count tokens (Contracts 25.2)
export const UNPRICED = "This session's model is not in the price table; only tokens are counted";
// Local config sessions are not bound to a variant (Contracts 25.4)
export const LOCAL_NO_BINDING = 'Local config sessions are not bound to a variant';

type ColumnKey =
  | 'select'
  | 'title'
  | 'cwd'
  | 'time'
  | 'requests'
  | 'tokens'
  | 'cost'
  | 'workflow'
  | 'variant'
  | 'live';

// Fixed table layout (Contracts 18.1). Columns with predictable content width (checkbox, time, numbers,
// workflow badges, variant, Live icon) have fixed widths; title 23%, directory 11% (under 35% together, title is
// the widest column); a wider table spreads the extra width proportionally. A run's session shows the run on
// the second line of the variant column (a run's session is bound to the variant the run used); Live interaction
// sessions show no binding kind (28.5); columns empty in every row are hidden
const columns: { key: ColumnKey; label: string; width: string; right?: boolean }[] = [
  { key: 'select', label: 'Select', width: '2.25rem' },
  { key: 'title', label: 'Title', width: '23%' },
  { key: 'cwd', label: 'Directory', width: '11%' },
  { key: 'time', label: 'Time', width: '5.5rem' },
  { key: 'requests', label: 'Requests', right: true, width: '3.5rem' },
  { key: 'tokens', label: 'Tokens', right: true, width: '4rem' },
  { key: 'cost', label: 'Cost', right: true, width: '4rem' },
  { key: 'workflow', label: 'Workflow', width: '4.5rem' },
  { key: 'variant', label: 'Variant', width: '7rem' },
  { key: 'live', label: 'Workspace', width: '2.75rem' },
];
// Columns without a visible header, for screen readers only (the checkbox column's header is the page checkbox)
const hiddenLabel = new Set<ColumnKey>(['live']);

const emptyWorkflow = (s: SessionSummary) => s.purpose === null && s.workflows.length === 0;

// Columns empty in every row: no workflow or purpose in the workflow column; all local config (unbound) in the
// variant column
function emptyColumns(sessions: SessionSummary[]): Set<ColumnKey> {
  const empty = new Set<ColumnKey>();
  if (sessions.length === 0) return empty;
  if (sessions.every(emptyWorkflow)) empty.add('workflow');
  if (sessions.every((s) => s.config === 'local')) empty.add('variant');
  return empty;
}

function cells(
  session: SessionSummary,
  selected: boolean,
  disabled: boolean,
  onToggle: () => void,
): Record<ColumnKey, ReactNode> {
  const title = session.title ?? '(no user message)';
  const duration = `to ${formatDateTime(session.endedAt)} · ${formatDuration(
    durationBetween(session.startedAt, session.endedAt),
  )}`;
  const note = tableBindingNote(session);
  return {
    select: (
      <td key="select" className="py-2.5 pl-3">
        {/* Above the whole-row link overlay */}
        <input
          type="checkbox"
          className="relative z-10 size-4"
          aria-label={`Select session ${session.id.slice(0, 8)}`}
          checked={selected}
          disabled={disabled}
          onChange={onToggle}
        />
      </td>
    ),
    title: (
      <td key="title" className="py-2.5 pr-3 pl-1">
        <Link
          to={`/sessions/${session.id}`}
          title={title}
          className="block truncate font-medium after:absolute after:inset-0 hover:underline"
        >
          {title}
        </Link>
        {session.archivedAt !== null && (
          <span
            className="mt-0.5 inline-block rounded border px-1.5 py-0.5 text-xs text-muted-foreground"
            data-testid="session-archived"
            title={`Archived ${formatDateTime(session.archivedAt)}`}
          >
            Archived
          </span>
        )}
        {session.importProblem !== null && <ImportProblemBadge problem={session.importProblem} />}
      </td>
    ),
    cwd: (
      <td key="cwd" className="py-2.5 pr-3 font-mono text-xs text-muted-foreground">
        <p className="truncate" title={session.cwd ?? ''} data-testid="session-cwd">
          {session.cwd ?? '—'}
        </p>
        <p className="flex min-w-0 items-center gap-1.5" title={session.id}>
          <span className="shrink-0">{session.id.slice(0, 8)}</span>
          {/* Session from an SSH host (Contracts 31.6): the directory is remote */}
          {session.host !== null && <HostLabel label={session.host.label} className="font-sans" />}
        </p>
      </td>
    ),
    time: (
      <td key="time" className="py-2.5 pr-3 text-xs tabular-nums">
        <p className="truncate" title={formatDateTime(session.startedAt)}>
          {formatDateTime(session.startedAt)}
        </p>
        <p className="truncate text-muted-foreground" title={duration}>
          {duration}
        </p>
      </td>
    ),
    requests: (
      <td
        key="requests"
        className="truncate py-2.5 pr-3 text-right text-sm tabular-nums"
        title={formatInteger(session.requestCount)}
      >
        {formatInteger(session.requestCount)}
      </td>
    ),
    tokens: (
      <td
        key="tokens"
        className="truncate py-2.5 pr-3 text-right text-sm tabular-nums"
        title={formatCount(totalTokens(session.tokens))}
      >
        {formatCount(totalTokens(session.tokens))}
      </td>
    ),
    cost: (
      <td
        key="cost"
        className="truncate py-2.5 pr-3 text-right text-sm tabular-nums"
        data-testid="session-cost"
        title={session.priced ? formatUsd(session.costUsd) : UNPRICED}
      >
        {session.priced ? formatUsd(session.costUsd) : '—'}
      </td>
    ),
    workflow: (
      <td key="workflow" className="py-2.5 pr-3" data-testid="session-workflow">
        <span className="flex flex-wrap items-center gap-1">
          {session.purpose !== null ? (
            <PurposeBadge purpose={session.purpose} />
          ) : (
            <WorkflowBadges workflows={session.workflows} />
          )}
        </span>
      </td>
    ),
    variant: (
      <td key="variant" className="py-2.5 pr-3 text-xs" data-testid="session-variant">
        {session.config === 'local' ? (
          <span className="text-muted-foreground" title={LOCAL_NO_BINDING}>
            —
          </span>
        ) : session.variant === null ? (
          <span className="text-muted-foreground">Not bound</span>
        ) : (
          <>
            <p className="truncate font-medium" title={session.variant.name}>
              {session.variant.name}
            </p>
            {note !== null &&
              ('run' in note ? (
                <p
                  className="truncate font-mono text-muted-foreground"
                  title={`run ${note.run}`}
                  data-testid="session-run"
                >
                  {note.run}
                </p>
              ) : (
                <p className="truncate text-muted-foreground" data-testid="session-binding-kind">
                  {note.label}
                </p>
              ))}
          </>
        )}
      </td>
    ),
    live: (
      <td key="live" className="py-2 pr-3">
        <OpenInLiveButton session={session} icon className="relative z-10" />
      </td>
    ),
  };
}

// Header checkbox: selects or clears this page, indeterminate when partly selected (Contracts 25.1)
function PageCheckbox({
  state,
  disabled,
  onToggle,
}: {
  state: 'none' | 'some' | 'all';
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <input
      type="checkbox"
      className="size-4 align-middle"
      aria-label="Select sessions on this page"
      data-testid="session-select-page"
      ref={(el) => {
        if (el !== null) el.indeterminate = state === 'some';
      }}
      checked={state === 'all'}
      disabled={disabled}
      onChange={onToggle}
    />
  );
}

export function SessionTable({
  sessions,
  isSelected,
  disabled,
  pageState,
  onToggle,
  onTogglePage,
}: {
  sessions: SessionSummary[];
  isSelected: (id: string) => boolean;
  // With all selected, the selection cannot change until all ids have loaded
  disabled: boolean;
  pageState: 'none' | 'some' | 'all';
  onToggle: (session: SessionSummary) => void;
  onTogglePage: () => void;
}) {
  const empty = emptyColumns(sessions);
  const shown = columns.filter((c) => !empty.has(c.key));
  return (
    <div className="rounded-lg border">
      <table className="w-full table-fixed text-left" data-testid="session-table">
        <colgroup>
          {shown.map((c) => (
            <col key={c.key} data-column={c.key} style={{ width: c.width }} />
          ))}
        </colgroup>
        <thead className="border-b bg-muted/40 text-xs text-muted-foreground [&_th]:truncate">
          <tr>
            {shown.map((c) => (
              <th
                key={c.key}
                className={cn(
                  'py-2 pr-3 font-medium',
                  c.key === 'select' && 'pl-3',
                  c.key === 'title' && 'pl-1',
                  c.right === true && 'text-right',
                )}
              >
                {c.key === 'select' ? (
                  <PageCheckbox state={pageState} disabled={disabled} onToggle={onTogglePage} />
                ) : hiddenLabel.has(c.key) ? (
                  <span className="sr-only">{c.label}</span>
                ) : c.key === 'variant' && sessions.some((s) => s.runId !== null) ? (
                  'Variant and run'
                ) : (
                  c.label
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="[&>tr]:relative">
          {sessions.map((s) => {
            const row = cells(s, isSelected(s.id), disabled, () => {
              onToggle(s);
            });
            return (
              <tr
                key={s.id}
                className="border-b align-top last:border-0 hover:bg-muted/40"
                data-testid="session-row"
                data-session={s.id}
              >
                {shown.map((c) => row[c.key])}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
