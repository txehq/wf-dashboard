import type { PersonStats } from '@/lib/team-api';
import {
  authoredText,
  authoredTitle,
  countText,
  type LinkedAuthored,
  linkedTitle,
  type Measure,
} from '@/lib/team-prs';
import type { Scale } from '@/lib/team-scale';

// PRs merged or Commits (Contracts 37.3): linked / authored, each number with how it is counted on hover. With a scale
// (the People table), each number is shown as it scales and its hover adds the total and per day
export function PrsMerged({
  measure,
  counts,
  person,
  scale,
}: {
  measure: Measure;
  counts: LinkedAuthored;
  person: PersonStats;
  scale?: Scale;
}) {
  const titled = (title: string, n: number) =>
    scale === undefined ? title : [title, scale.title(n)].filter((t) => t !== '').join('. ');
  return (
    <span className="tabular-nums">
      <span title={titled(linkedTitle(measure, counts.linkedUnread), counts.linked)}>
        {countText(counts.linked, counts.linkedUnread, scale?.format)}
      </span>
      /
      <span
        title={
          person.github.login === null
            ? authoredTitle(measure, person, counts.authoredUnread)
            : titled(authoredTitle(measure, person, counts.authoredUnread), counts.authored)
        }
      >
        {authoredText(counts, person, scale?.format)}
      </span>
    </span>
  );
}
