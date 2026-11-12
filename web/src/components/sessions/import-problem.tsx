import { formatDateTime } from '@/lib/format';
import type { SessionSummary } from '@/lib/sessions-api';
import { cn } from '@/lib/utils';

// Incremental import problems (Requirements Log cycle 13, item 19): a failure affects only this session, its
// original text is shown here and the next incremental import retries; waiting means a referenced spill file
// has not been synced yet

type Problem = NonNullable<SessionSummary['importProblem']>;

const LABEL = { failed: 'Import failed', waiting: 'Waiting for spill file' } as const;

// Under the title in the manage table: a badge with the original text on hover
export function ImportProblemBadge({ problem }: { problem: Problem }) {
  return (
    <span
      className={cn(
        'mt-0.5 inline-block rounded border px-1.5 py-0.5 text-xs',
        problem.kind === 'failed'
          ? 'border-destructive/40 text-destructive'
          : 'text-muted-foreground',
      )}
      data-testid="session-import-problem"
      title={`${formatDateTime(problem.at)} ${problem.message}`}
    >
      {LABEL[problem.kind]}
    </span>
  );
}

// Detail: the original text
export function ImportProblemNotice({ problem }: { problem: Problem }) {
  return (
    <section
      role={problem.kind === 'failed' ? 'alert' : 'status'}
      className={cn(
        'flex flex-col gap-1 rounded-lg border px-4 py-3 text-sm',
        problem.kind === 'failed' ? 'border-destructive/40' : 'border-border',
      )}
      data-testid="session-import-problem"
    >
      <p className={cn('font-medium', problem.kind === 'failed' && 'text-destructive')}>
        {problem.kind === 'failed'
          ? `Incremental import failed (${formatDateTime(problem.at)}). Every incremental import retries it. Original error:`
          : `Waiting for a spill file since ${formatDateTime(problem.at)}. Import continues once it appears.`}
      </p>
      <pre className="font-mono text-xs break-all whitespace-pre-wrap text-muted-foreground">
        {problem.message}
      </pre>
    </section>
  );
}
