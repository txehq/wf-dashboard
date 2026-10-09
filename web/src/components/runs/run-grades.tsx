import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { formatUsd } from '@/lib/format';
import { artifactLabel, type RunGrades, runGradesQuery } from '@/lib/compare';
import { cn } from '@/lib/utils';

const outcomeLabel = {
  passed: '通过',
  failed: '失败',
  errored: '出错',
  skipped: '跳过',
  'not-run': '未运行',
} as const;

function LfgGrades({ grades }: { grades: NonNullable<RunGrades['lfg']> }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">
        合计{' '}
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
            {artifactLabel[group.artifact]}
            <span className="tabular-nums">
              {group.score} / {group.maxScore}
            </span>
            <span className="text-xs font-normal text-muted-foreground">
              {group.present
                ? `${group.judgeModel ?? ''} · ${formatUsd(group.costUsd)}`
                : '产物不存在，每条记 0 分'}
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

function IcGrades({ grades }: { grades: NonNullable<RunGrades['ic']> }) {
  const { detail } = grades;
  return (
    <div className="flex flex-col gap-3">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-muted-foreground">隐藏测试</dt>
        <dd className="tabular-nums">
          <span className="text-lg font-semibold">
            {grades.testsPassed} / {grades.testsDeclared}
          </span>{' '}
          通过
        </dd>
        <dt className="text-muted-foreground">终点</dt>
        <dd>{grades.reachedEnd ? '已到达（ready for review 且 CI 全绿）' : '未到达'}</dd>
        {detail.endpoint !== null && (
          <>
            <dt className="text-muted-foreground">CI</dt>
            <dd>
              {detail.endpoint.ciGreen ? '全绿' : '未全绿'}
              {detail.endpoint.missingRequired.length > 0 &&
                `，缺少必需检查：${detail.endpoint.missingRequired.join('、')}`}
            </dd>
            <dt className="text-muted-foreground">PR 状态</dt>
            <dd>{detail.endpoint.isDraft ? '草稿' : 'ready for review'}</dd>
          </>
        )}
        <dt className="text-muted-foreground">PR</dt>
        <dd>
          {detail.pr === null ? (
            '没有 PR'
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
      {detail.fileErrors.map((e) => (
        <p key={e.file} className="text-sm text-destructive">
          <span className="font-mono text-xs">{e.file}</span>：{e.message}
        </p>
      ))}
      <table className="w-full text-sm" data-testid="grade-tests">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-1.5 pr-3 font-medium">隐藏测试</th>
            <th className="w-20 py-1.5 font-medium">结果</th>
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

export function RunGradesPanel({ runId }: { runId: string }) {
  const grades = useQuery(runGradesQuery(runId));
  return (
    <section
      className="flex flex-col gap-3 rounded-lg border px-4 py-3"
      aria-labelledby="grades-title"
      data-testid="run-grades"
    >
      <h2 id="grades-title" className="text-sm font-medium">
        评分
      </h2>
      {grades.isPending && <p className="text-sm text-muted-foreground">加载中…</p>}
      {grades.isError && <p className="text-sm text-destructive">{grades.error.message}</p>}
      {grades.data?.lfg != null && <LfgGrades grades={grades.data.lfg} />}
      {grades.data?.ic != null && <IcGrades grades={grades.data.ic} />}
    </section>
  );
}
