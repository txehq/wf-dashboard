import { formatInteger } from '@/lib/format';
import type { PersonStats } from '@/lib/team-api';

// PRs merged and Commits (Contracts 37.3) are each two numbers over the same two sets of merged PRs: linked to an issue /
// authored by the person. Without a GitHub account the second is unknown, shown as —. A PR whose commit count is not
// read yet is left out of Commits: the number then shows + (or ? when no PR of the set is read) and its hover says how
// many are unread

export type Measure = 'prs' | 'commits';

export interface LinkedAuthored {
  linked: number;
  authored: number;
  // PRs of each set whose commit count is not read yet
  linkedUnread: number;
  authoredUnread: number;
}

// A day cell or a person's totals (whose authored numbers are null without an account)
interface PrCounts {
  prsMerged: number;
  prsAuthored: number | null;
  commits: number;
  commitsUnread: number;
  commitsAuthored: number | null;
  commitsAuthoredUnread: number;
}

// c is undefined for a day with nothing
export function linkedAuthored(measure: Measure, c: PrCounts | undefined): LinkedAuthored {
  if (c === undefined) return { linked: 0, authored: 0, linkedUnread: 0, authoredUnread: 0 };
  return measure === 'prs'
    ? { linked: c.prsMerged, authored: c.prsAuthored ?? 0, linkedUnread: 0, authoredUnread: 0 }
    : {
        linked: c.commits,
        authored: c.commitsAuthored ?? 0,
        linkedUnread: c.commitsUnread,
        authoredUnread: c.commitsAuthoredUnread,
      };
}

export const measureLabel: Record<Measure, string> = { prs: 'PRs merged', commits: 'Commits' };

export const measureTitle: Record<Measure, string> = {
  prs: 'Merged PRs linked to an issue / authored by the person, linked or not. Sorted by the first',
  commits:
    'Commits in the same merged PRs as PRs merged: linked to an issue / authored by the person. Sorted by the first',
};

const unreadText = (unread: number) =>
  unread === 0
    ? ''
    : unread === 1
      ? '. 1 PR not read yet: its commits are left out'
      : `. ${formatInteger(unread)} PRs not read yet: their commits are left out`;

export function linkedTitle(measure: Measure, unread: number) {
  return measure === 'prs'
    ? "Merged PRs linked to an issue, on the day each merged, counted for the issue's assignee"
    : `Commits in the merged PRs linked to an issue, on the day each PR merged, counted for the issue's assignee${unreadText(unread)}`;
}

export function authoredTitle(measure: Measure, person: PersonStats, unread: number) {
  const { github } = person;
  const what = measure === 'prs' ? 'PRs' : 'Commits';
  if (github.login === null) return `Authored ${what} unknown: ${github.reason}`;
  const account =
    github.source === 'linear'
      ? 'GitHub account from Linear'
      : 'GitHub account guessed: the most common author of the merged PRs linked to their issues';
  const counted =
    measure === 'prs'
      ? `Merged PRs ${github.login} authored in the team's repos, linked to an issue or not, on the day each merged`
      : `Commits in the merged PRs ${github.login} authored in the team's repos, linked to an issue or not, on the day each PR merged${unreadText(unread)}`;
  return `${counted}. ${account}`;
}

// The known sum, + when some PRs are unread, ? when all are
export const countText = (known: number, unread: number, format = formatInteger) =>
  unread === 0 ? format(known) : known === 0 ? '?' : `${format(known)}+`;

export const authoredText = (n: LinkedAuthored, person: PersonStats, format = formatInteger) =>
  person.github.login === null ? '—' : countText(n.authored, n.authoredUnread, format);

// As one line of text, with the unread PRs of each set when there are any
export function linkedAuthoredText(n: LinkedAuthored, person: PersonStats) {
  const text = `${countText(n.linked, n.linkedUnread)}/${authoredText(n, person)}`;
  const authoredUnread = person.github.login === null ? 0 : n.authoredUnread;
  if (n.linkedUnread === 0 && authoredUnread === 0) return text;
  return `${text} (commits of ${formatInteger(n.linkedUnread)}/${formatInteger(authoredUnread)} PRs not read yet)`;
}
