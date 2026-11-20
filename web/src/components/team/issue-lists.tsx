import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState } from 'react';
import { Pager } from '@/components/pager';
import { Section } from '@/components/team/section';
import { Button } from '@/components/ui/button';
import { formatInteger, formatNoun } from '@/lib/format';
import {
  type IssuesQuery,
  type Person,
  type PrProblem,
  type TeamIssuePr,
  type TeamIssueRow,
  teamIssuesQuery,
} from '@/lib/team-api';
import { dateTime, shortDate } from '@/lib/team-days';
import { duration } from '@/lib/team-durations';
import { cn } from '@/lib/utils';

// The Issues list and the txe PRs list page alike
export const PAGE_SIZE = 50;

function prState(pr: TeamIssuePr): { label: string; className: string } {
  if (pr.error !== null) return { label: 'unreadable', className: 'text-destructive' };
  if (pr.mergedAt !== null) return { label: 'merged', className: 'text-(--viz-status-good-text)' };
  if (pr.state === 'open') return { label: pr.draft === true ? 'draft' : 'open', className: '' };
  return { label: 'closed', className: 'text-muted-foreground' };
}

// The PRs of one issue. The merge date is shown where it is the evidence (Done but not closed); in the Issues list the
// Completed column already carries the time
function PrLinks({
  prs,
  timeZone,
  withDate = false,
}: {
  prs: TeamIssuePr[];
  timeZone: string;
  withDate?: boolean;
}) {
  if (prs.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <ul className="flex flex-col gap-0.5">
      {prs.map((pr) => {
        const state = prState(pr);
        return (
          <li key={pr.url} className="whitespace-nowrap">
            <a
              href={pr.url}
              target="_blank"
              rel="noreferrer"
              className="underline-offset-2 hover:underline"
            >
              {pr.repo.split('/')[1]}#{pr.number}
            </a>{' '}
            <span className={state.className}>{state.label}</span>
            {withDate && pr.mergedAt !== null && (
              <span className="text-muted-foreground"> {shortDate(pr.mergedAt, timeZone)}</span>
            )}
            {pr.additions !== null && pr.deletions !== null && pr.error === null && (
              <span className="ml-1 tabular-nums">
                <span className="text-(--viz-status-good-text)">
                  +{formatInteger(pr.additions)}
                </span>{' '}
                <span className="text-destructive">−{formatInteger(pr.deletions)}</span>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function NotClosedTag() {
  return (
    <span
      className="rounded bg-warning px-1 text-xs whitespace-nowrap text-warning-foreground"
      title="Its PRs are merged and none is open, but the issue is still open in Linear"
    >
      Not closed
    </span>
  );
}

// With a person selected, their name is the reason the row is listed, so it stands out
function PersonCell({ person, selected }: { person: Person; selected: string | null }) {
  return (
    <td
      className={cn(
        'px-3 py-1.5 whitespace-nowrap',
        selected !== null && (person.key === selected ? 'font-medium' : 'text-muted-foreground'),
      )}
    >
      {person.name}
    </td>
  );
}

function IssueTable({
  issues,
  selected,
  timeZone,
}: {
  issues: TeamIssueRow[];
  // The selected person's key
  selected: string | null;
  timeZone: string;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border">
      <table className="w-full text-sm" data-testid="issues-table">
        <thead>
          <tr className="border-b bg-muted/40 text-left text-xs text-muted-foreground">
            <th className="px-3 py-2 font-medium">Issue</th>
            <th className="px-3 py-2 font-medium">Title</th>
            <th className="px-3 py-2 font-medium">Assignee</th>
            <th className="px-3 py-2 font-medium">Creator</th>
            <th className="px-3 py-2 font-medium">Status</th>
            <th className="px-3 py-2 font-medium">Completed</th>
            <th
              className="px-3 py-2 text-right font-medium whitespace-nowrap"
              title="From creation to completion or cancellation"
            >
              Created → closed
            </th>
            <th
              className="px-3 py-2 text-right font-medium whitespace-nowrap"
              title="From first entering a started state to completion or cancellation"
            >
              Started → closed
            </th>
            <th className="px-3 py-2 font-medium">PRs</th>
          </tr>
        </thead>
        <tbody>
          {issues.map((i) => (
            <tr
              key={i.identifier}
              className="border-b align-top last:border-0"
              data-testid={`issue-${i.identifier}`}
            >
              <td className="px-3 py-1.5 whitespace-nowrap">
                <a
                  href={i.url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-xs underline-offset-2 hover:underline"
                >
                  {i.identifier}
                </a>
              </td>
              {/* max-w-0 lets the title give up width so the names and PRs stay whole */}
              <td className="w-full max-w-0 min-w-40 px-3 py-1.5">
                <span className="line-clamp-2">{i.title}</span>
              </td>
              <PersonCell person={i.assignee} selected={selected} />
              <PersonCell person={i.creator} selected={selected} />
              <td className="px-3 py-1.5 whitespace-nowrap">
                {i.status} {i.doneNotClosed && <NotClosedTag />}
              </td>
              <td className="px-3 py-1.5 whitespace-nowrap text-muted-foreground">
                {i.completedAt === null ? '—' : dateTime(i.completedAt, timeZone)}
              </td>
              <td className="px-3 py-1.5 text-right whitespace-nowrap tabular-nums">
                {i.createdToClosed === null ? '—' : duration(i.createdToClosed)}
              </td>
              <td className="px-3 py-1.5 text-right whitespace-nowrap tabular-nums">
                {i.startedToClosed === null ? '—' : duration(i.startedToClosed)}
              </td>
              <td className="px-3 py-1.5 text-xs">
                <PrLinks prs={i.prs} timeZone={timeZone} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// Issues list (37.4): follows the selection above (a person, the range, or a heatmap cell)
export function IssuesSection({
  query,
  scope,
  onClear,
  timeZone,
}: {
  query: IssuesQuery;
  // What the list is filtered to, for example "Ding · Nov 3"
  scope: string;
  onClear: (() => void) | null;
  timeZone: string;
}) {
  const issues = useQuery({ ...teamIssuesQuery(query), placeholderData: (previous) => previous });
  const [page, setPage] = useState(1);
  const [key, setKey] = useState(JSON.stringify(query));
  if (key !== JSON.stringify(query)) {
    setKey(JSON.stringify(query));
    setPage(1);
  }
  const list = issues.data ?? [];
  return (
    <Section
      testId="issues-section"
      title={`Issues · ${scope}`}
      action={
        <>
          {onClear !== null && (
            <Button size="sm" variant="ghost" data-testid="clear-selection" onClick={onClear}>
              <X />
              Clear
            </Button>
          )}
          <span className="ml-auto">
            <Pager
              page={page}
              pageSize={PAGE_SIZE}
              total={list.length}
              unit={list.length === 1 ? 'issue' : 'issues'}
              label="Issue pages"
              onPage={setPage}
              testId="issues-pager"
            />
          </span>
        </>
      }
    >
      {issues.isError && <p className="text-sm text-destructive">{issues.error.message}</p>}
      {issues.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {issues.data !== undefined &&
        (list.length === 0 ? (
          <p className="text-sm text-muted-foreground">No issues in this selection.</p>
        ) : (
          <IssueTable
            issues={list.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)}
            selected={query.person}
            timeZone={timeZone}
          />
        ))}
    </Section>
  );
}

// Every issue done but not closed (37.4), grouped by assignee, with the evidence
export function DoneNotClosedSection({ people, timeZone }: { people: string[]; timeZone: string }) {
  const issues = useQuery(
    teamIssuesQuery({ from: null, to: null, people, person: null, day: null, doneNotClosed: true }),
  );
  const groups = new Map<string, TeamIssueRow[]>();
  for (const i of issues.data ?? [])
    groups.set(i.assignee.name, [...(groups.get(i.assignee.name) ?? []), i]);
  return (
    <Section
      testId="done-not-closed"
      title={`Done but not closed${issues.data === undefined ? '' : ` · ${formatInteger(issues.data.length)}`}`}
      action={
        <span className="text-sm text-muted-foreground">
          PRs merged, none open, issue still open in Linear. Close them in Linear.
        </span>
      }
    >
      {issues.isError && <p className="text-sm text-destructive">{issues.error.message}</p>}
      {issues.data?.length === 0 && (
        <p className="text-sm text-muted-foreground">
          None. Every issue with merged PRs is closed.
        </p>
      )}
      {[...groups]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, list]) => (
          <div key={name} className="flex flex-col gap-1" data-testid={`not-closed-${name}`}>
            <h3 className="text-sm font-medium">
              {name}{' '}
              <span className="font-normal text-muted-foreground">
                · {formatNoun(list.length, 'issue')}
              </span>
            </h3>
            <ul className="flex flex-col divide-y rounded-lg border text-sm">
              {list.map((i) => (
                <li
                  key={i.identifier}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-1.5"
                >
                  <a
                    href={i.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-xs underline-offset-2 hover:underline"
                  >
                    {i.identifier}
                  </a>
                  <span className="min-w-0 flex-1 truncate">{i.title}</span>
                  <span className="text-xs whitespace-nowrap">{i.status}</span>
                  <span className="text-xs">
                    <PrLinks prs={i.prs} timeZone={timeZone} withDate />
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
    </Section>
  );
}

// PRs that could not be read (404, 403), with gh's text; they are not counted. The first few show, the rest on demand
const PROBLEMS_SHOWN = 5;

export function PrProblemsSection({
  problems,
  timeZone,
}: {
  problems: PrProblem[];
  timeZone: string;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? problems : problems.slice(0, PROBLEMS_SHOWN);
  return (
    <Section
      testId="pr-problems"
      title={`PR problems · ${formatInteger(problems.length)}`}
      action={
        <>
          <span className="text-sm text-muted-foreground">Not counted.</span>
          {problems.length > PROBLEMS_SHOWN && (
            <Button
              size="sm"
              variant="ghost"
              data-testid="pr-problems-toggle"
              onClick={() => {
                setAll(!all);
              }}
            >
              {all ? 'Show fewer' : `Show all ${formatInteger(problems.length)}`}
            </Button>
          )}
        </>
      }
    >
      {problems.length === 0 ? (
        <p className="text-sm text-muted-foreground">Every linked PR was read.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-lg border text-sm">
          {shown.map((p) => (
            <li
              key={p.url}
              className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 px-3 py-1.5"
              data-testid="pr-problem"
            >
              <a
                href={p.url}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-2 hover:underline"
              >
                {p.repo}#{p.number}
              </a>
              <code className="text-xs text-destructive" title={p.error}>
                {p.error.split('\n')[0]}
              </code>
              <span className="text-xs text-muted-foreground">
                Linked from {p.issues.join(', ')}
              </span>
              <span className="ml-auto text-xs text-muted-foreground">
                Read {dateTime(p.readAt, timeZone)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
