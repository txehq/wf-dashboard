import { GitBranch, LoaderCircle } from 'lucide-react';
import { deployLogUrl, type MagiAgentView } from '@/lib/magi-api';
import { cn } from '@/lib/utils';

// Magi Agent 这一项的工具栏与准备进度（Contracts 23.2、23.5、23.6）

// worktree 的分支相对 main 领先与落后的 commit 数、未提交的文件数
export function BranchStatus({ worktree }: { worktree: MagiAgentView['worktree'] }) {
  return (
    <span
      className="inline-flex min-w-0 shrink items-center gap-1 text-xs text-muted-foreground"
      data-testid="magi-branch"
      title={
        worktree.ahead === null
          ? worktree.path
          : `${worktree.path}：${worktree.branch} 领先 main ${String(worktree.ahead)} 个 commit，落后 ${String(worktree.behind)} 个，未提交的文件 ${String(worktree.uncommitted)} 个`
      }
    >
      <GitBranch className="size-3.5 shrink-0" aria-hidden />
      <span className="truncate">
        <span className="font-mono">{worktree.branch}</span>
        {worktree.ahead !== null && (
          <span data-testid="magi-branch-counts">
            {' '}
            · 领先 {worktree.ahead} · 落后 {worktree.behind} · 未提交 {worktree.uncommitted}
          </span>
        )}
      </span>
    </span>
  );
}

const deployStatusLabel = {
  running: '部署中',
  failed: '上一次部署失败',
  restarting: '部署完成，正在重新启动',
  done: '上一次部署',
} as const;

// 部署的进度与上一次部署的结果，链接到检查的日志
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
        {step !== undefined && `：${step.label}`}
        {deploy.status === 'done' && deploy.commit !== null && `：${deploy.commit.slice(0, 7)}`}
      </span>
      <a
        href={deployLogUrl(deploy.id)}
        target="_blank"
        rel="noreferrer"
        className="shrink-0 underline"
        data-testid="magi-deploy-log"
      >
        日志
      </a>
    </span>
  );
}

const stepStatusLabel = {
  pending: '等待',
  running: '进行中',
  done: '完成',
  failed: '失败',
} as const;

// 第一次打开时建 worktree 与 pnpm install 的进度；失败时显示命令输出的原文，再次打开时重试
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
          ? '准备 worktree 失败，再次打开 Magi Agent 时重试。'
          : `第一次打开：在 ${worktree.path} 建 worktree 并安装依赖，完成后启动。`}
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
