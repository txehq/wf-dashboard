import { useMutation } from '@tanstack/react-query';
import type {
  CommitSource,
  ImportPreview,
  WorkflowAnalysis,
  WorkflowJob,
  WorkflowJobStatus,
} from '@wf-dashboard/server/tasks/import-schema';
import { Download, ExternalLink, RefreshCw } from 'lucide-react';
import { useId, useState } from 'react';
import { MarkdownDoc } from '@/components/markdown-doc';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { formatUsd } from '@/lib/format';
import type { IcForm } from '@/lib/task-form';
import { previewImport } from '@/lib/tasks';

// Jobs with no runner in the copy, which never run
const cannotRun: WorkflowJobStatus[] = ['runner-unavailable', 'retired', 'blocked'];

const statusLabel: Record<WorkflowJobStatus, string> = {
  required: 'Counts toward endpoint',
  'runner-unavailable': 'Runner not available in the copy',
  retired: 'Retired runner',
  blocked: 'Depends on a job that cannot run',
  'not-on-pr': 'Not triggered by PRs',
  'path-filtered': 'Runs only on changes to certain paths',
  unresolved: 'Cannot be determined statically',
  invalid: 'Invalid workflow',
};

function commitSourceText(source: CommitSource) {
  switch (source.kind) {
    case 'merged-pr':
      return `base commit of PR #${String(source.pr.number)} (merged) linked to the ticket`;
    case 'default-branch':
      return `the ticket has no linked merged PR, so the latest commit on the default branch ${source.branch}`;
    case 'given':
      return 'set by hand';
  }
}

function JobTable({ jobs, testId }: { jobs: WorkflowJob[]; testId: string }) {
  return (
    <table className="w-full table-fixed text-sm" data-testid={testId}>
      <thead>
        <tr className="border-b text-left text-xs text-muted-foreground">
          <th className="w-1/4 py-1.5 pr-3 font-medium">job</th>
          <th className="w-1/6 px-3 py-1.5 font-medium">runs-on</th>
          <th className="w-1/6 px-3 py-1.5 font-medium">Status</th>
          <th className="py-1.5 pl-3 font-medium">Reason</th>
        </tr>
      </thead>
      <tbody>
        {jobs.map((j) => (
          <tr
            key={`${j.workflow}\0${j.jobId}\0${j.checkName ?? ''}`}
            className="border-b align-top last:border-0"
          >
            <td className="py-1 pr-3 break-words">
              {j.checkName ?? j.jobId}
              <span className="block font-mono text-xs text-muted-foreground">
                {j.workflow.replace('.github/workflows/', '')}
              </span>
            </td>
            <td className="px-3 py-1 font-mono text-xs break-words">{j.runsOn ?? '—'}</td>
            <td className="px-3 py-1">{statusLabel[j.status]}</td>
            <td className="py-1 pl-3 break-words text-muted-foreground">{j.reason}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// Count by status and runs-on, e.g. "56 jobs: Runner not available in the copy arc-linux-dind"
function summarize(jobs: WorkflowJob[]) {
  const groups = new Map<
    string,
    { key: string; status: WorkflowJobStatus; runsOn: string | null; count: number }
  >();
  for (const j of jobs) {
    const runsOn = j.status === 'blocked' ? null : j.runsOn;
    const key = `${j.status}\0${runsOn ?? ''}`;
    const group = groups.get(key) ?? { key, status: j.status, runsOn, count: 0 };
    group.count += 1;
    groups.set(key, group);
  }
  return [...groups.values()];
}

// Workflow analysis: default requiredChecks, jobs that cannot run in the copy, and other jobs that do not count toward the endpoint
export function WorkflowChecks({ analysis }: { analysis: WorkflowAnalysis }) {
  const blocked = analysis.jobs.filter((j) => cannotRun.includes(j.status));
  const others = analysis.jobs.filter(
    (j) => j.status !== 'required' && !cannotRun.includes(j.status),
  );
  return (
    <div className="flex flex-col gap-3" data-testid="workflow-checks">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">
          Checks that can run on copy PRs (default requiredChecks)
        </h3>
        {analysis.requiredChecks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            None. The endpoint only requires the PR to not be a draft.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1">
            {analysis.requiredChecks.map((c) => (
              <Badge key={c} variant="secondary" className="font-mono">
                {c}
              </Badge>
            ))}
          </div>
        )}
      </div>
      {blocked.length > 0 && (
        <div className="flex flex-col gap-1">
          <h3 className="text-sm font-medium">
            Jobs that cannot run in the copy ({blocked.length}): not counted toward the endpoint
          </h3>
          <ul className="list-disc pl-5 text-sm" data-testid="jobs-cannot-run-summary">
            {summarize(blocked).map((g) => (
              <li key={g.key}>
                {g.count} {g.count === 1 ? 'job' : 'jobs'}: {statusLabel[g.status]}
                {g.runsOn === null ? '' : ` ${g.runsOn}`}
              </li>
            ))}
          </ul>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">List each job</summary>
            <div className="mt-2">
              <JobTable jobs={blocked} testId="jobs-cannot-run" />
            </div>
          </details>
        </div>
      )}
      {others.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">
            Other jobs not counted toward the endpoint ({others.length})
          </summary>
          <div className="mt-2">
            <JobTable jobs={others} testId="jobs-not-counted" />
          </div>
        </details>
      )}
    </div>
  );
}

function TextInput({
  label,
  value,
  placeholder,
  onChange,
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
        }}
      />
    </div>
  );
}

function ImportPreviewView({ preview }: { preview: ImportPreview }) {
  const { issue } = preview;
  const drafted = preview.criteria;
  if (drafted === null) throw new Error('The preview has no acceptance criteria');
  return (
    <div className="flex flex-col gap-5" data-testid="import-preview">
      <div className="flex flex-col gap-1">
        <a
          href={issue.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex w-fit items-center gap-1 font-mono text-sm underline"
        >
          {issue.identifier}
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
        <h3 className="text-lg font-semibold">{issue.title}</h3>
        <p className="text-sm text-muted-foreground">
          {issue.status} · {issue.project ?? 'No project'} · body {issue.description.length}{' '}
          {issue.description.length === 1 ? 'character' : 'characters'}
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Body (imported in full)</h3>
        {issue.description.trim() === '' ? (
          <p className="text-sm text-muted-foreground">
            The ticket has no body. Fill it in on the form before use.
          </p>
        ) : (
          <MarkdownDoc content={issue.description} className="max-h-96" />
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">Acceptance criteria (used for grading)</h3>
        <p className="text-xs text-muted-foreground" data-testid="criteria-cost">
          Determined by {drafted.model} from the full ticket · {drafted.inputTokens} input,{' '}
          {drafted.outputTokens} output tokens · {formatUsd(drafted.costUsd)}. You can add, remove
          and edit them on the form after use.
        </p>
        {drafted.criteria.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="no-criteria">
            The ticket has no body. Fill it in on the form before use.
          </p>
        ) : (
          <ol
            className="flex list-decimal flex-col gap-2 pl-5 text-sm"
            data-testid="import-criteria"
          >
            {drafted.criteria.map((c) => (
              <li key={c.text}>
                <span className="whitespace-pre-wrap">{c.text}</span>
                <blockquote className="mt-0.5 border-l-2 pl-2 text-xs text-muted-foreground">
                  Quoted from body: {c.quote}
                </blockquote>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="flex flex-col gap-1 text-sm" data-testid="import-repo">
        <h3 className="font-medium">Starting repo</h3>
        <p>
          <span className="font-mono">{preview.repo}</span> @{' '}
          <span className="font-mono">{preview.commit.slice(0, 12)}</span> · {preview.commitTitle}{' '}
          <span className="text-muted-foreground">({preview.commitDate.slice(0, 10)})</span>
        </p>
        <p className="text-muted-foreground">
          Commit source: {commitSourceText(preview.commitSource)}
        </p>
      </div>
      <WorkflowChecks analysis={preview.workflows} />
    </div>
  );
}

// For a new ic task, paste a ticket URL or ID to import; repo and commit use defaults when omitted
export function LinearImportPanel({ onAdopt }: { onAdopt: (preview: ImportPreview) => void }) {
  const [issue, setIssue] = useState('');
  const [repo, setRepo] = useState('');
  const [commit, setCommit] = useState('');
  const reading = useMutation({
    mutationFn: () =>
      previewImport({
        issue: issue.trim(),
        ...(repo.trim() === '' ? {} : { repo: repo.trim() }),
        ...(commit.trim() === '' ? {} : { commit: commit.trim() }),
      }),
  });
  return (
    <Card data-testid="linear-import">
      <CardHeader>
        <CardTitle>Import from Linear</CardTitle>
        <p className="text-sm text-muted-foreground">
          Only reads the original ticket and source repo. Each run still creates its own ticket copy
          and repo copy.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <TextInput
          label="Ticket URL or ID"
          value={issue}
          placeholder="https://linear.app/capso/issue/TXE-3546/… or TXE-3546"
          onChange={setIssue}
        />
        <div className="grid grid-cols-2 gap-4">
          <TextInput
            label="GitHub repo (owner/name)"
            value={repo}
            placeholder="Defaults to the repo of the ticket's merged PR"
            onChange={setRepo}
          />
          <TextInput
            label="commit"
            value={commit}
            placeholder="Defaults to that PR's base commit"
            onChange={setCommit}
          />
        </div>
        <div className="flex gap-2">
          <Button
            disabled={issue.trim() === '' || reading.isPending}
            onClick={() => {
              reading.mutate();
            }}
          >
            <Download />
            {reading.isPending ? 'Reading…' : 'Read ticket'}
          </Button>
          {reading.data !== undefined && (
            <Button
              variant="outline"
              onClick={() => {
                onAdopt(reading.data);
              }}
            >
              Use this content
            </Button>
          )}
        </div>
        {reading.isError && (
          <Alert variant="destructive">
            <AlertTitle>Could not read</AlertTitle>
            <AlertDescription>{reading.error.message}</AlertDescription>
          </Alert>
        )}
        {reading.data !== undefined && <ImportPreviewView preview={reading.data} />}
      </CardContent>
    </Card>
  );
}

// Task imported from Linear: source repo and commit are editable; re-reading the workflows resets requiredChecks to the defaults
export function SourceRepoFields({
  form,
  analysis,
  onChange,
  onAnalysis,
}: {
  form: IcForm & { source: NonNullable<IcForm['source']> };
  analysis: WorkflowAnalysis | null;
  onChange: (form: IcForm) => void;
  onAnalysis: (analysis: WorkflowAnalysis) => void;
}) {
  const { source } = form;
  const rereading = useMutation({
    // Re-reads only the workflows; acceptance criteria are not determined again
    mutationFn: () =>
      previewImport({
        issue: source.linear.identifier,
        repo: source.github.repo,
        commit: form.repo.commit,
        criteria: false,
      }),
    onSuccess: (preview) => {
      onAnalysis(preview.workflows);
      onChange({ ...form, requiredChecks: preview.workflows.requiredChecks });
    },
  });
  return (
    <Card data-testid="source-repo">
      <CardHeader>
        <CardTitle>Starting repo and checks</CardTitle>
        <p className="text-sm text-muted-foreground">
          Source ticket{' '}
          <a href={source.linear.url} target="_blank" rel="noreferrer" className="underline">
            {source.linear.identifier}
          </a>
          . Saving creates repo.bundle at this commit and writes nothing to the source repo.
        </p>
        <CardAction>
          <Button
            variant="outline"
            disabled={rereading.isPending}
            onClick={() => {
              rereading.mutate();
            }}
          >
            <RefreshCw />
            {rereading.isPending ? 'Reading…' : 'Re-read workflows at this commit'}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <TextInput
            label="GitHub repo"
            value={source.github.repo}
            onChange={(repo) => {
              // Repo changed: the ticket's linked PRs belong to the old repo and no longer match
              onChange({
                ...form,
                source: {
                  ...source,
                  github: { repo, prs: repo === source.github.repo ? source.github.prs : [] },
                },
              });
            }}
          />
          <TextInput
            label="Pinned commit"
            value={form.repo.commit}
            onChange={(commit) => {
              onChange({ ...form, repo: { ...form.repo, commit } });
            }}
          />
        </div>
        {rereading.isError && (
          <Alert variant="destructive">
            <AlertTitle>Could not read</AlertTitle>
            <AlertDescription>{rereading.error.message}</AlertDescription>
          </Alert>
        )}
        {analysis !== null && <WorkflowChecks analysis={analysis} />}
      </CardContent>
    </Card>
  );
}
