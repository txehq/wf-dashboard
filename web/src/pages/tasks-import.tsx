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

// 副本中没有 runner、永远不会运行的 job
const cannotRun: WorkflowJobStatus[] = ['self-hosted', 'retired', 'blocked'];

const statusLabel: Record<WorkflowJobStatus, string> = {
  required: '计入终点',
  'self-hosted': '自托管 runner',
  retired: '已停用的 runner',
  blocked: '依赖无法运行的 job',
  'not-on-pr': '不由 PR 触发',
  'path-filtered': '只在特定路径改动时运行',
  unresolved: '无法静态确定',
  invalid: 'workflow 不合法',
};

function commitSourceText(source: CommitSource) {
  switch (source.kind) {
    case 'merged-pr':
      return `工单关联的 PR #${String(source.pr.number)}（已合并）的 base commit`;
    case 'default-branch':
      return `工单没有关联已合并的 PR，取默认分支 ${source.branch} 的最新 commit`;
    case 'given':
      return '手动指定';
  }
}

function JobTable({ jobs, testId }: { jobs: WorkflowJob[]; testId: string }) {
  return (
    <table className="w-full table-fixed text-sm" data-testid={testId}>
      <thead>
        <tr className="border-b text-left text-xs text-muted-foreground">
          <th className="w-1/4 py-1.5 pr-3 font-medium">job</th>
          <th className="w-1/6 px-3 py-1.5 font-medium">runs-on</th>
          <th className="w-1/6 px-3 py-1.5 font-medium">情况</th>
          <th className="py-1.5 pl-3 font-medium">原因</th>
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

// 按情况与 runs-on 归并计数，例如"56 个 job：自托管 runner arc-linux-dind"
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

// workflow 的分析结果：requiredChecks 的默认值、副本中无法运行的 job、其余不计入终点的 job
export function WorkflowChecks({ analysis }: { analysis: WorkflowAnalysis }) {
  const blocked = analysis.jobs.filter((j) => cannotRun.includes(j.status));
  const others = analysis.jobs.filter(
    (j) => j.status !== 'required' && !cannotRun.includes(j.status),
  );
  return (
    <div className="flex flex-col gap-3" data-testid="workflow-checks">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">
          能在副本 PR 上运行的 check（requiredChecks 的默认值）
        </h3>
        {analysis.requiredChecks.length === 0 ? (
          <p className="text-sm text-muted-foreground">没有。终点只要求 PR 不是草稿。</p>
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
            无法在副本中运行的 job（{blocked.length}）：不计入终点
          </h3>
          <ul className="list-disc pl-5 text-sm" data-testid="jobs-cannot-run-summary">
            {summarize(blocked).map((g) => (
              <li key={g.key}>
                {g.count} 个 job：{statusLabel[g.status]}
                {g.runsOn === null ? '' : ` ${g.runsOn}`}
              </li>
            ))}
          </ul>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted-foreground">逐个列出</summary>
            <div className="mt-2">
              <JobTable jobs={blocked} testId="jobs-cannot-run" />
            </div>
          </details>
        </div>
      )}
      {others.length > 0 && (
        <details className="text-sm">
          <summary className="cursor-pointer font-medium">
            其他不计入终点的 job（{others.length}）
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
  if (drafted === null) throw new Error('预览中没有确定验收标准');
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
          {issue.status} · {issue.project ?? '没有 project'} · 正文 {issue.description.length} 字符
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">正文（完整导入）</h3>
        {issue.description.trim() === '' ? (
          <p className="text-sm text-muted-foreground">工单没有正文，使用前在表单中填写。</p>
        ) : (
          <MarkdownDoc content={issue.description} className="max-h-96" />
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">验收标准（用于评分）</h3>
        <p className="text-xs text-muted-foreground" data-testid="criteria-cost">
          由 {drafted.model} 读工单全文确定 · 输入 {drafted.inputTokens} 输出 {drafted.outputTokens}{' '}
          token · {formatUsd(drafted.costUsd)}
          。使用后可在表单中增删改。
        </p>
        {drafted.criteria.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="no-criteria">
            工单没有正文，使用前在表单中填写。
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
                  正文原文：{c.quote}
                </blockquote>
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="flex flex-col gap-1 text-sm" data-testid="import-repo">
        <h3 className="font-medium">起始仓库</h3>
        <p>
          <span className="font-mono">{preview.repo}</span> @{' '}
          <span className="font-mono">{preview.commit.slice(0, 12)}</span> · {preview.commitTitle}{' '}
          <span className="text-muted-foreground">({preview.commitDate.slice(0, 10)})</span>
        </p>
        <p className="text-muted-foreground">
          commit 来源：{commitSourceText(preview.commitSource)}
        </p>
      </div>
      <WorkflowChecks analysis={preview.workflows} />
    </div>
  );
}

// 新建 ic task 时粘贴工单地址或编号导入；仓库与 commit 省略时按默认值
export function LinearImportPanel({
  onAdopt,
  initialIssue = '',
}: {
  onAdopt: (preview: ImportPreview) => void;
  // 交互区"另存为 task"带来的工单地址
  initialIssue?: string;
}) {
  const [issue, setIssue] = useState(initialIssue);
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
        <CardTitle>从 Linear 导入</CardTitle>
        <p className="text-sm text-muted-foreground">
          只读取原工单与源仓库。每次 run 照常建工单副本与仓库副本。
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <TextInput
          label="工单地址或编号"
          value={issue}
          placeholder="https://linear.app/capso/issue/TXE-3546/… 或 TXE-3546"
          onChange={setIssue}
        />
        <div className="grid grid-cols-2 gap-4">
          <TextInput
            label="GitHub 仓库（owner/name）"
            value={repo}
            placeholder="默认取工单关联的已合并 PR 的仓库"
            onChange={setRepo}
          />
          <TextInput
            label="commit"
            value={commit}
            placeholder="默认取该 PR 的 base commit"
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
            {reading.isPending ? '读取中…' : '读取工单'}
          </Button>
          {reading.data !== undefined && (
            <Button
              variant="outline"
              onClick={() => {
                onAdopt(reading.data);
              }}
            >
              使用这些内容
            </Button>
          )}
        </div>
        {reading.isError && (
          <Alert variant="destructive">
            <AlertTitle>读取失败</AlertTitle>
            <AlertDescription>{reading.error.message}</AlertDescription>
          </Alert>
        )}
        {reading.data !== undefined && <ImportPreviewView preview={reading.data} />}
      </CardContent>
    </Card>
  );
}

// 从 Linear 导入的 task：源仓库与 commit 可改，按它们重新读取 workflow 并把 requiredChecks 换成默认值
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
    // 只重新读取 workflow，不再确定验收标准
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
        <CardTitle>起始仓库与 checks</CardTitle>
        <p className="text-sm text-muted-foreground">
          来源工单{' '}
          <a href={source.linear.url} target="_blank" rel="noreferrer" className="underline">
            {source.linear.identifier}
          </a>
          。保存时在这个 commit 生成 repo.bundle，不向源仓库写任何东西。
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
            {rereading.isPending ? '读取中…' : '按此 commit 重新读取 workflow'}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-4">
          <TextInput
            label="GitHub 仓库"
            value={source.github.repo}
            onChange={(repo) => {
              onChange({ ...form, source: { ...source, github: { repo } } });
            }}
          />
          <TextInput
            label="固定 commit"
            value={form.repo.commit}
            onChange={(commit) => {
              onChange({ ...form, repo: { ...form.repo, commit } });
            }}
          />
        </div>
        {rereading.isError && (
          <Alert variant="destructive">
            <AlertTitle>读取失败</AlertTitle>
            <AlertDescription>{rereading.error.message}</AlertDescription>
          </Alert>
        )}
        {analysis !== null && <WorkflowChecks analysis={analysis} />}
      </CardContent>
    </Card>
  );
}
