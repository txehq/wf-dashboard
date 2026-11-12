import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { formatUsd } from '@/lib/format';
import { artifactLabel, type RunGrades, runGradesQuery } from '@/lib/compare';
import { cn } from '@/lib/utils';

const outcomeLabel = {
  passed: 'Passed',
  failed: 'Failed',
  errored: 'Errored',
  skipped: 'Skipped',
  'not-run': 'Not run',
} as const;

type Endpoint = RunGrades['endpoint'];

// pr-endpoint result; hidden when the evaluation kind has no pr-endpoint
function EndpointRow({ endpoint, reachedText }: { endpoint: Endpoint; reachedText: string }) {
  if (endpoint === null) return null;
  return (
    <>
      <dt className="text-muted-foreground">Endpoint</dt>
      <dd>{endpoint.reached ? reachedText : 'Not reached'}</dd>
    </>
  );
}

function LfgGrades({ grades }: { grades: NonNullable<RunGrades['rubric']> }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">
        Total{' '}
        <span className="text-lg font-semibold tabular-nums">
          {grades.score} / {grades.maxScore}
        </span>
      </p>
      {grades.artifacts.map((group) => (
        <div
          key={group.artifact}
          className="flex flex-col gap-1"
          data-testid={`grade-${group.artifact}`}
        >
          <h3 className="flex flex-wrap items-baseline gap-2 text-sm font-medium">
            {artifactLabel(group.artifact)}
            <span className="tabular-nums">
              {group.score} / {group.maxScore}
            </span>
            <span className="text-xs font-normal text-muted-foreground">
              {group.present
                ? `${group.judgeModel ?? ''} · ${formatUsd(group.costUsd)}`
                : 'Output missing, every item scores 0'}
            </span>
          </h3>
          <table className="w-full table-fixed text-sm">
            <tbody>
              {group.items.map((item) => (
                <tr key={item.itemId} className="border-b align-top last:border-0">
                  <td className="w-2/5 py-1.5 pr-3">
                    <span className="mr-1 font-mono text-xs text-muted-foreground">
                      {item.itemId}
                    </span>
                    {item.criterion}
                  </td>
                  <td className="w-16 px-3 py-1.5 font-semibold tabular-nums">
                    {item.score} / {item.maxScore}
                  </td>
                  <td className="py-1.5 pl-3 text-muted-foreground">{item.reasoning}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function IcGrades({
  grades,
  endpoint,
}: {
  grades: NonNullable<RunGrades['hiddenTests']>;
  endpoint: Endpoint;
}) {
  const { detail } = grades;
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Hidden tests</dt>
        <dd className="tabular-nums">
          <span className="text-lg font-semibold">
            {grades.testsPassed} / {grades.testsDeclared}
          </span>{' '}
          passed
        </dd>
        <EndpointRow
          endpoint={endpoint}
          reachedText="Reached (ready for review and CI all green)"
        />
        {detail.endpoint !== null && (
          <>
            <dt className="text-muted-foreground">CI</dt>
            <dd>
              {detail.endpoint.ciGreen ? 'All green' : 'Not all green'}
              {detail.endpoint.missingRequired.length > 0 &&
                `; missing required checks: ${detail.endpoint.missingRequired.join(', ')}`}
            </dd>
            <dt className="text-muted-foreground">PR status</dt>
            <dd>{detail.endpoint.isDraft ? 'Draft' : 'Ready for review'}</dd>
          </>
        )}
        <dt className="text-muted-foreground">PR</dt>
        <dd>
          {detail.pr === null ? (
            'No PR'
          ) : (
            <a
              href={detail.pr.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline"
            >
              #{detail.pr.number} · {detail.pr.branch}
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          )}
        </dd>
      </dl>
      {/* The agent's code kept the hidden tests from running (npm ci failed, timeout, no JUnit written): tests score 0; show the cause and raw text */}
      {detail.error !== null && (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 px-3 py-2 text-sm"
          data-testid="grade-error"
        >
          <p className="font-medium text-destructive">
            Hidden tests did not run properly; tests score 0
          </p>
          <pre className="mt-1 max-h-60 overflow-auto text-xs whitespace-pre-wrap">
            {detail.error}
          </pre>
        </div>
      )}
      {detail.fileErrors.map((e) => (
        <p key={e.file} className="text-sm text-destructive">
          <span className="font-mono text-xs">{e.file}</span>: {e.message}
        </p>
      ))}
      <table className="w-full text-sm" data-testid="grade-tests">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-1.5 pr-3 font-medium">Hidden test</th>
            <th className="w-20 py-1.5 font-medium">Result</th>
          </tr>
        </thead>
        <tbody>
          {detail.outcomes.map((o) => (
            <tr key={`${o.file}\0${o.name}`} className="border-b last:border-0">
              <td className="py-1 pr-3">
                {o.name}
                <span className="ml-2 font-mono text-xs text-muted-foreground">{o.file}</span>
              </td>
              <td
                className={cn(
                  'py-1',
                  o.outcome === 'passed'
                    ? 'text-[var(--status-good)]'
                    : 'text-[var(--status-critical)]',
                )}
              >
                {o.outcome === 'passed' ? '✓ ' : '✗ '}
                {outcomeLabel[o.outcome]}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ic task without hidden tests: the judge scores each acceptance criterion (0 not met, 1 partly met, 2 met)
function CriteriaGrades({
  grades,
  endpoint,
}: {
  grades: NonNullable<RunGrades['criteria']>;
  endpoint: Endpoint;
}) {
  const { detail } = grades;
  return (
    <div className="flex flex-col gap-3" data-testid="grade-criteria">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">Acceptance criteria</dt>
        <dd className="tabular-nums">
          <span className="text-lg font-semibold">
            {grades.score} / {grades.maxScore}
          </span>{' '}
          <span className="text-xs text-muted-foreground">
            {grades.judgeModel === null
              ? 'No PR, every item scores 0'
              : `${grades.judgeModel} · ${formatUsd(grades.costUsd)}`}
          </span>
        </dd>
        <EndpointRow
          endpoint={endpoint}
          reachedText="Reached (PR is not a draft and required checks passed)"
        />
        {detail.endpoint !== null && detail.endpoint.missingRequired.length > 0 && (
          <>
            <dt className="text-muted-foreground">CI</dt>
            <dd>Required checks not passed: {detail.endpoint.missingRequired.join(', ')}</dd>
          </>
        )}
        <dt className="text-muted-foreground">PR</dt>
        <dd>
          {detail.pr === null ? (
            'No PR'
          ) : (
            <a
              href={detail.pr.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 underline"
            >
              #{detail.pr.number} · {detail.pr.branch}
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          )}
        </dd>
      </dl>
      <table className="w-full table-fixed text-sm">
        <tbody>
          {grades.items.map((item) => (
            <tr key={item.itemId} className="border-b align-top last:border-0">
              <td className="w-2/5 py-1.5 pr-3">
                <span className="mr-1 font-mono text-xs text-muted-foreground">{item.itemId}</span>
                {item.criterion}
              </td>
              <td className="w-16 px-3 py-1.5 font-semibold tabular-nums">
                {item.score} / {item.maxScore}
              </td>
              <td className="py-1.5 pl-3 text-muted-foreground">{item.reasoning}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RunGradesPanel({ runId }: { runId: string }) {
  const grades = useQuery(runGradesQuery(runId));
  return (
    <section
      className="flex flex-col gap-3 rounded-lg border px-4 py-3"
      aria-labelledby="grades-title"
      data-testid="run-grades"
    >
      <h2 id="grades-title" className="text-sm font-medium">
        Grade
      </h2>
      {grades.isPending && <p className="text-sm text-muted-foreground">Loading…</p>}
      {grades.isError && <p className="text-sm text-destructive">{grades.error.message}</p>}
      {grades.data?.rubric != null && <LfgGrades grades={grades.data.rubric} />}
      {grades.data?.hiddenTests != null && (
        <IcGrades grades={grades.data.hiddenTests} endpoint={grades.data.endpoint} />
      )}
      {grades.data?.criteria != null && (
        <CriteriaGrades grades={grades.data.criteria} endpoint={grades.data.endpoint} />
      )}
      {grades.data?.hiddenTests === null &&
        grades.data.criteria === null &&
        grades.data.endpoint !== null && (
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <EndpointRow
              endpoint={grades.data.endpoint}
              reachedText="Reached (PR is not a draft and required checks passed)"
            />
          </dl>
        )}
    </section>
  );
}
