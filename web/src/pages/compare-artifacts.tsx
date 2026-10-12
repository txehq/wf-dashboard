import { useQuery } from '@tanstack/react-query';
import type { IcCriteriaGrade } from '@wf-dashboard/server/grading/schema';
import type { TaskRecord } from '@wf-dashboard/server/tasks/schema';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { MarkdownDoc } from '@/components/markdown-doc';
import {
  artifactLabel,
  type CompareRun,
  outcomeRows,
  type RunGrades,
  runArtifactsQuery,
  runGradesQuery,
  type SelectedVariant,
} from '@/lib/compare';
import { cn } from '@/lib/utils';

const outcomeLabel = {
  passed: '通过',
  failed: '失败',
  errored: '出错',
  skipped: '跳过',
  'not-run': '未运行',
} as const;

function RunSelect({
  label,
  value,
  runs,
  variants,
  onChange,
}: {
  label: string;
  value: string;
  runs: CompareRun[];
  variants: SelectedVariant[];
  onChange: (id: string) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      {label}
      <select
        aria-label={label}
        className="h-8 rounded-md border bg-background px-2"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {variants.map((v) => (
          <optgroup key={v.id} label={v.name}>
            {runs
              .filter((r) => r.variantId === v.id)
              .map((r) => (
                <option key={r.id} value={r.id}>
                  {v.name} · {r.id}
                  {r.humanIntervened ? ' · 有人工干预' : ''}
                </option>
              ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function RunHeading({ run, variants }: { run: CompareRun; variants: SelectedVariant[] }) {
  const variant = variants.find((v) => v.id === run.variantId);
  if (variant === undefined) throw new Error(`run ${run.id} 的 variant 未选中`);
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <span className="font-medium">{variant.name}</span>
      <Link to={`/runs/${run.id}`} className="font-mono text-xs underline">
        {run.id}
      </Link>
      {run.humanIntervened && (
        <span className="rounded border px-1.5 text-xs text-muted-foreground">有人工干预</span>
      )}
    </div>
  );
}

function groupOf(grades: RunGrades, artifact: string) {
  const group = grades.rubric?.artifacts.find((a) => a.artifact === artifact);
  if (group === undefined) throw new Error(`run ${grades.runId} 没有 ${artifact} 的评分`);
  return group;
}

function MarkdownPane({ runId, artifact }: { runId: string; artifact: string }) {
  const data = useQuery(runArtifactsQuery(runId));
  if (data.isPending) return <p className="text-sm text-muted-foreground">加载中…</p>;
  if (data.isError) return <p className="text-sm text-destructive">{data.error.message}</p>;
  const found = data.data.artifacts.find((a) => a.kind === artifact);
  if (found?.snapshot == null) {
    return (
      <p className="text-sm text-muted-foreground">这次 run 没有产出 {artifactLabel(artifact)}。</p>
    );
  }
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="truncate font-mono text-xs text-muted-foreground" title={found.location}>
        {found.location}
      </p>
      <MarkdownDoc content={found.snapshot} className="max-h-[640px]" />
    </div>
  );
}

function LfgSideBySide({
  left,
  right,
  runs,
  variants,
  artifacts,
  artifact,
  onArtifact,
}: {
  left: RunGrades;
  right: RunGrades;
  runs: [CompareRun, CompareRun];
  variants: SelectedVariant[];
  // task 的 rubric 分组，即大阶段 rubric 积木的产物
  artifacts: string[];
  artifact: string;
  onArtifact: (a: string) => void;
}) {
  const leftGroup = groupOf(left, artifact);
  const rightGroup = groupOf(right, artifact);
  return (
    <div className="flex flex-col gap-4">
      <div role="tablist" aria-label="产物" className="flex gap-1 border-b">
        {artifacts.map((a) => (
          <button
            key={a}
            type="button"
            role="tab"
            aria-selected={artifact === a}
            className={cn(
              '-mb-px border-b-2 border-transparent px-3 py-1.5 text-sm text-muted-foreground',
              artifact === a && 'border-foreground font-medium text-foreground',
            )}
            onClick={() => {
              onArtifact(a);
            }}
          >
            {artifactLabel(a)}
          </button>
        ))}
      </div>
      <table className="w-full table-fixed text-sm" data-testid="rubric-side-by-side">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="w-1/4 py-1.5 pr-3 font-medium">rubric 条目</th>
            <th className="px-3 py-1.5 font-medium">
              <RunHeading run={runs[0]} variants={variants} />
            </th>
            <th className="px-3 py-1.5 font-medium">
              <RunHeading run={runs[1]} variants={variants} />
            </th>
          </tr>
        </thead>
        <tbody>
          {leftGroup.items.map((item) => {
            const other = rightGroup.items.find((x) => x.itemId === item.itemId);
            return (
              <tr key={item.itemId} className="border-b align-top last:border-0">
                <td className="py-2 pr-3">
                  <span className="mr-1 font-mono text-xs text-muted-foreground">
                    {item.itemId}
                  </span>
                  {item.criterion}
                </td>
                {[item, other].map((x, i) => (
                  <td key={i} className="px-3 py-2">
                    {x === undefined ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      <>
                        <span
                          className={cn(
                            'font-semibold tabular-nums',
                            other !== undefined &&
                              other.score !== item.score &&
                              'underline decoration-2',
                          )}
                        >
                          {x.score} / {x.maxScore}
                        </span>
                        <p className="mt-0.5 text-muted-foreground">{x.reasoning}</p>
                      </>
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
          <tr className="border-t font-medium">
            <td className="py-2 pr-3">合计</td>
            <td className="px-3 py-2 tabular-nums">
              {leftGroup.score} / {leftGroup.maxScore}
            </td>
            <td className="px-3 py-2 tabular-nums">
              {rightGroup.score} / {rightGroup.maxScore}
            </td>
          </tr>
        </tbody>
      </table>
      <div className="grid grid-cols-2 gap-4">
        <MarkdownPane runId={runs[0].id} artifact={artifact} />
        <MarkdownPane runId={runs[1].id} artifact={artifact} />
      </div>
    </div>
  );
}

function IcSummary({
  grades,
  run,
  variants,
}: {
  grades: RunGrades;
  run: CompareRun;
  variants: SelectedVariant[];
}) {
  if (grades.hiddenTests === null) throw new Error(`run ${grades.runId} 没有隐藏测试评分`);
  const { detail, testsPassed, testsDeclared } = grades.hiddenTests;
  const reachedEnd = grades.endpoint?.reached ?? null;
  const endpoint = detail.endpoint;
  return (
    <div className="flex flex-col gap-2 rounded-lg border p-4 text-sm" data-testid="ic-summary">
      <RunHeading run={run} variants={variants} />
      {detail.pr === null ? (
        <p className="text-muted-foreground">没有 PR</p>
      ) : (
        <a
          href={detail.pr.url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 underline"
        >
          PR #{detail.pr.number} · {detail.pr.branch}
          <ExternalLink className="size-3.5" />
        </a>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
        <dt className="text-muted-foreground">隐藏测试</dt>
        <dd className="tabular-nums">
          {testsPassed} / {testsDeclared} 通过
        </dd>
        {reachedEnd !== null && (
          <>
            <dt className="text-muted-foreground">终点</dt>
            <dd>{reachedEnd ? '已到达（ready for review 且 CI 全绿）' : '未到达'}</dd>
          </>
        )}
        {endpoint !== null && (
          <>
            <dt className="text-muted-foreground">CI</dt>
            <dd>
              {endpoint.ciGreen ? '全绿' : '未全绿'}
              {endpoint.missingRequired.length > 0 &&
                `，缺少必需检查：${endpoint.missingRequired.join('、')}`}
            </dd>
            <dt className="text-muted-foreground">PR 状态</dt>
            <dd>{endpoint.isDraft ? '草稿' : 'ready for review'}</dd>
          </>
        )}
      </dl>
      {detail.fileErrors.map((e) => (
        <p key={e.file} className="text-destructive">
          <span className="font-mono text-xs">{e.file}</span>：{e.message}
        </p>
      ))}
    </div>
  );
}

function IcSideBySide({
  left,
  right,
  runs,
  variants,
}: {
  left: RunGrades;
  right: RunGrades;
  runs: [CompareRun, CompareRun];
  variants: SelectedVariant[];
}) {
  const leftOutcomes = left.hiddenTests?.detail.outcomes ?? [];
  const rightOutcomes = right.hiddenTests?.detail.outcomes ?? [];
  const rows = outcomeRows(leftOutcomes, rightOutcomes);
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <IcSummary grades={left} run={runs[0]} variants={variants} />
        <IcSummary grades={right} run={runs[1]} variants={variants} />
      </div>
      <table className="w-full text-sm" data-testid="ic-tests">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="py-1.5 pr-3 font-medium">隐藏测试</th>
            <th className="w-28 px-3 py-1.5 font-medium">左</th>
            <th className="w-28 px-3 py-1.5 font-medium">右</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ key, name, file, left: mine, right: other }) => {
            const differs = other?.outcome !== mine?.outcome;
            return (
              <tr key={key} className={cn('border-b last:border-0', differs && 'bg-muted/50')}>
                <td className="py-1 pr-3">
                  {name}
                  <span className="ml-2 font-mono text-xs text-muted-foreground">{file}</span>
                </td>
                {[mine, other].map((x, i) => (
                  <td
                    key={i}
                    className={cn(
                      'px-3 py-1',
                      x?.outcome === 'passed'
                        ? 'text-[var(--status-good)]'
                        : 'text-[var(--status-critical)]',
                    )}
                  >
                    {x === undefined ? '—' : outcomeLabel[x.outcome]}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function ArtifactSideBySide({
  tasks,
  runs,
  variants,
}: {
  tasks: TaskRecord[];
  runs: CompareRun[];
  variants: SelectedVariant[];
}) {
  const withRuns = tasks.filter((t) => runs.some((r) => r.taskId === t.task.id));
  const [taskId, setTaskId] = useState<string | null>(null);
  // 产物的选择在换 run 时保留；不在当前 task 的分组中时取第一组
  const [chosenArtifact, setArtifact] = useState<string | null>(null);
  const task = withRuns.find((t) => t.task.id === taskId) ?? withRuns[0];
  const rubricArtifacts = task?.task.rubric?.map((g) => g.artifact) ?? null;
  const artifact =
    chosenArtifact !== null && rubricArtifacts?.includes(chosenArtifact) === true
      ? chosenArtifact
      : (rubricArtifacts?.[0] ?? '');
  const taskRuns = runs.filter((r) => r.taskId === task?.task.id);
  // 默认左边是基线的第一次 run，右边是另一个 variant 的第一次 run
  const [picked, setPicked] = useState<{ taskId: string; left: string; right: string } | null>(
    null,
  );
  if (task === undefined) {
    return <p className="text-sm text-muted-foreground">选中的 task 没有已评分的 run。</p>;
  }
  const defaults = () => {
    const [baseline, ...others] = variants;
    const left = taskRuns.find((r) => r.variantId === baseline?.id) ?? taskRuns[0];
    const right =
      taskRuns.find((r) => others.some((v) => v.id === r.variantId)) ??
      taskRuns.find((r) => r.id !== left?.id) ??
      left;
    if (left === undefined || right === undefined) throw new Error('task 没有 run');
    return { left: left.id, right: right.id };
  };
  const current =
    picked !== null && picked.taskId === task.task.id
      ? picked
      : { taskId: task.task.id, ...defaults() };
  const leftRun = taskRuns.find((r) => r.id === current.left);
  const rightRun = taskRuns.find((r) => r.id === current.right);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          task
          <select
            aria-label="产物并排的 task"
            className="h-8 rounded-md border bg-background px-2"
            value={task.task.id}
            onChange={(event) => {
              setTaskId(event.target.value);
              setPicked(null);
            }}
          >
            {withRuns.map((t) => (
              <option key={t.task.id} value={t.task.id}>
                {t.task.title}
              </option>
            ))}
          </select>
        </label>
        <RunSelect
          label="左"
          value={current.left}
          runs={taskRuns}
          variants={variants}
          onChange={(id) => {
            setPicked({ ...current, left: id });
          }}
        />
        <RunSelect
          label="右"
          value={current.right}
          runs={taskRuns}
          variants={variants}
          onChange={(id) => {
            setPicked({ ...current, right: id });
          }}
        />
      </div>
      {leftRun !== undefined && rightRun !== undefined && (
        <Pair
          artifacts={rubricArtifacts}
          runs={[leftRun, rightRun]}
          variants={variants}
          artifact={artifact}
          onArtifact={setArtifact}
        />
      )}
    </div>
  );
}

function Pair({
  artifacts,
  runs,
  variants,
  artifact,
  onArtifact,
}: {
  // task 的 rubric 分组；没有 rubric 的 task 为空
  artifacts: string[] | null;
  runs: [CompareRun, CompareRun];
  variants: SelectedVariant[];
  artifact: string;
  onArtifact: (a: string) => void;
}) {
  const left = useQuery(runGradesQuery(runs[0].id));
  const right = useQuery(runGradesQuery(runs[1].id));
  if (left.isPending || right.isPending) {
    return <p className="text-sm text-muted-foreground">加载中…</p>;
  }
  if (left.isError) return <p className="text-sm text-destructive">{left.error.message}</p>;
  if (right.isError) return <p className="text-sm text-destructive">{right.error.message}</p>;
  if (artifacts !== null) {
    return (
      <LfgSideBySide
        left={left.data}
        right={right.data}
        runs={runs}
        variants={variants}
        artifacts={artifacts}
        artifact={artifact}
        onArtifact={onArtifact}
      />
    );
  }
  const leftCriteria = left.data.criteria;
  const rightCriteria = right.data.criteria;
  if (leftCriteria !== null && rightCriteria !== null) {
    return (
      <CriteriaSideBySide
        left={leftCriteria}
        right={rightCriteria}
        reached={[left.data.endpoint?.reached ?? null, right.data.endpoint?.reached ?? null]}
        runs={runs}
        variants={variants}
      />
    );
  }
  return <IcSideBySide left={left.data} right={right.data} runs={runs} variants={variants} />;
}

// 没有隐藏测试的 task：两次 run 的验收标准逐条得分与理由；reached 为两次 run 的终点判定（没选 pr-endpoint 时为空）
function CriteriaSideBySide({
  left,
  right,
  reached,
  runs,
  variants,
}: {
  left: IcCriteriaGrade;
  right: IcCriteriaGrade;
  reached: [boolean | null, boolean | null];
  runs: [CompareRun, CompareRun];
  variants: SelectedVariant[];
}) {
  return (
    <div className="flex flex-col gap-4" data-testid="criteria-side-by-side">
      <div className="grid grid-cols-2 gap-4">
        {[left, right].map((g, i) => {
          const run = runs[i];
          if (run === undefined) throw new Error('缺少对比的 run');
          const end = reached[i] ?? null;
          return (
            <div key={run.id} className="flex flex-col gap-2 rounded-lg border p-4 text-sm">
              <RunHeading run={run} variants={variants} />
              <p className="tabular-nums">
                验收标准 {g.score} / {g.maxScore}
                {end === null ? '' : ` · ${end ? '已到达终点' : '未到达终点'}`}
              </p>
              {g.detail.pr !== null && (
                <a
                  href={g.detail.pr.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 underline"
                >
                  PR #{g.detail.pr.number} · {g.detail.pr.branch}
                  <ExternalLink className="size-3.5" />
                </a>
              )}
            </div>
          );
        })}
      </div>
      <table className="w-full table-fixed text-sm">
        <thead>
          <tr className="border-b text-left text-xs text-muted-foreground">
            <th className="w-1/4 py-1.5 pr-3 font-medium">验收标准</th>
            <th className="px-3 py-1.5 font-medium">左</th>
            <th className="px-3 py-1.5 font-medium">右</th>
          </tr>
        </thead>
        <tbody>
          {left.items.map((item, i) => {
            const other = right.items[i];
            return (
              <tr
                key={item.itemId}
                className={cn(
                  'border-b align-top last:border-0',
                  other?.score !== item.score && 'bg-muted/50',
                )}
              >
                <td className="py-1.5 pr-3">
                  <span className="mr-1 font-mono text-xs text-muted-foreground">
                    {item.itemId}
                  </span>
                  {item.criterion}
                </td>
                {[item, other].map((x, j) => (
                  <td key={j} className="px-3 py-1.5">
                    {x === undefined ? (
                      '—'
                    ) : (
                      <>
                        <span className="font-semibold tabular-nums">
                          {x.score} / {x.maxScore}
                        </span>{' '}
                        <span className="text-muted-foreground">{x.reasoning}</span>
                      </>
                    )}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
