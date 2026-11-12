import { GitBranch, LoaderCircle, Package } from 'lucide-react';
import { deployLogUrl, type MagiAgentView } from '@/lib/magi-api';
import { cn } from '@/lib/utils';

// Toolbar and preparation progress of the Magi Agent item (Contracts 23.2, 23.5, 23.6)

const count = (n: number | null, noun: string) => `${String(n)} ${noun}${n === 1 ? '' : 's'}`;

// Commits the worktree branch is ahead of and behind main, and the number of uncommitted files; an installed release
// package has its read-only sources instead (Contracts 39.5)
export function BranchStatus({ worktree }: { worktree: MagiAgentView['worktree'] }) {
  if (worktree.source === 'package') {
    return (
      <span
        className="inline-flex min-w-0 shrink items-center gap-1 text-xs text-muted-foreground"
        data-testid="magi-branch"
        title={`${worktree.path}: the installed package's sources, read-only; this installation updates from GitHub Releases and cannot deploy`}
      >
        <Package className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">Release package · read-only</span>
      </span>
    );
  }
  return (
    <span
      className="inline-flex min-w-0 shrink items-center gap-1 text-xs text-muted-foreground"
      data-testid="magi-branch"
      title={
        worktree.ahead === null
          ? worktree.path
          : `${worktree.path}: ${worktree.branch} is ${count(worktree.ahead, 'commit')} ahead of main and ${String(worktree.behind)} behind, ${count(worktree.uncommitted, 'uncommitted file')}`
      }
    >
      <GitBranch className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">
        <span className="font-mono">{worktree.branch}</span>
        {worktree.ahead !== null && (
          <span data-testid="magi-branch-counts">
            {' '}
            · {worktree.ahead} ahead · {worktree.behind} behind · {worktree.uncommitted} uncommitted
          </span>
        )}
      </span>
    </span>
  );
}

const deployStatusLabel = {
  running: 'Deploying',
  failed: 'Last deploy failed',
  restarting: 'Deployed, restarting',
  done: 'Last deploy',
} as const;

// Deploy progress and the result of the last deploy, linking to the check log
export function DeployStatus({ deploy }: { deploy: MagiAgentView['deploy'] }) {
  if (deploy === null) return null;
  const step =
    deploy.status === 'running'
      ? deploy.steps.find((s) => s.status === 'running')
      : deploy.steps.find((s) => s.status === 'failed');
  return (
    <span
      className={cn(
        'inline-flex min-w-0 shrink-0 items-center gap-1 text-xs',
        deploy.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
      )}
      data-testid="magi-deploy"
      data-status={deploy.status}
      title={deploy.error ?? undefined}
    >
      {deploy.status === 'running' && (
        <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
      )}
      <span className="truncate">
        {deployStatusLabel[deploy.status]}
        {step !== undefined && `: ${step.label}`}
        {deploy.status === 'done' && deploy.commit !== null && `: ${deploy.commit.slice(0, 7)}`}
      </span>
      <a
        href={deployLogUrl(deploy.id)}
        target="_blank"
        rel="noreferrer"
        className="shrink-0 underline"
        data-testid="magi-deploy-log"
      >
        Log
      </a>
    </span>
  );
}

const stepStatusLabel = {
  pending: 'Pending',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
} as const;

// Progress of creating the worktree and running pnpm install on first open; on failure shows the raw
// command output, and opening again retries
export function WorktreePreparation({ magi }: { magi: MagiAgentView }) {
  const { worktree } = magi;
  return (
    <div
      className="flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto rounded-md border p-4 text-sm"
      data-testid="magi-preparation"
      data-state={worktree.state}
    >
      <p>
        {worktree.state === 'failed'
          ? "Couldn't prepare the worktree. Open Magi Agent again to retry."
          : `First open: creating a worktree at ${worktree.path} and installing dependencies, then starting.`}
      </p>
      <ol className="flex flex-col gap-2">
        {worktree.steps.map((s) => (
          <li key={s.id} data-testid="magi-preparation-step" data-status={s.status}>
            <span className="flex items-center gap-2">
              {s.status === 'running' && (
                <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
              )}
              <span className="font-medium">{s.label}</span>
              <span
                className={cn(
                  'text-xs',
                  s.status === 'failed' ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {stepStatusLabel[s.status]}
              </span>
            </span>
            {s.status === 'failed' && s.output !== null && (
              <pre className="mt-1 max-h-60 overflow-auto rounded bg-muted p-2 font-mono text-xs whitespace-pre-wrap">
                {s.output}
              </pre>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
