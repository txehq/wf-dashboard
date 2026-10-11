import { useMutation } from '@tanstack/react-query';
import type { WorkflowAnalysis } from '@wf-dashboard/server/tasks/import-schema';
import {
  type ArtifactRubric,
  type RubricDraft,
  rubricMaxScore,
} from '@wf-dashboard/server/tasks/schema';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import { useId, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import {
  artifactLabels,
  fromForm,
  type IcForm,
  type LfgForm,
  type TaskForm,
} from '@/lib/task-form';
import { draftRubric } from '@/lib/tasks';
import { SourceRepoFields } from '@/pages/tasks-import';

function Field({ label, children }: { label: string; children: (id: string) => React.ReactNode }) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id}>{label}</Label>
      {children(id)}
    </div>
  );
}

function TextField({
  label,
  value,
  onChange,
  multiline = false,
  disabled = false,
  rows,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: boolean;
  disabled?: boolean;
  rows?: number;
}) {
  return (
    <Field label={label}>
      {(id) =>
        multiline ? (
          <Textarea
            id={id}
            value={value}
            rows={rows}
            disabled={disabled}
            className="field-sizing-fixed"
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
        ) : (
          <Input
            id={id}
            value={value}
            disabled={disabled}
            onChange={(e) => {
              onChange(e.target.value);
            }}
          />
        )
      }
    </Field>
  );
}

function nextItemId(group: ArtifactRubric) {
  const prefix = group.artifact[0] ?? 'x';
  const used = new Set(group.items.map((i) => i.id));
  let n = group.items.length + 1;
  while (used.has(`${prefix}${String(n)}`)) n++;
  return `${prefix}${String(n)}`;
}

function RubricGroupEditor({
  group,
  onChange,
}: {
  group: ArtifactRubric;
  onChange: (group: ArtifactRubric) => void;
}) {
  const label = artifactLabels[group.artifact];
  const updateItem = (index: number, patch: Partial<ArtifactRubric['items'][number]>) => {
    onChange({
      ...group,
      items: group.items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    });
  };
  return (
    <div className="flex flex-col gap-2" data-testid={`rubric-${group.artifact}`}>
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{label}</h3>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            onChange({
              ...group,
              items: [...group.items, { id: nextItemId(group), criterion: '', maxScore: 3 }],
            });
          }}
        >
          <Plus />
          添加条目
        </Button>
      </div>
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-24">编号</TableHead>
            <TableHead>判定标准</TableHead>
            <TableHead className="w-24">满分</TableHead>
            <TableHead className="w-12">
              <span className="sr-only">删除</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {group.items.map((item, index) => (
            <TableRow key={index}>
              <TableCell className="align-top">
                <Input
                  aria-label={`${label} 第 ${String(index + 1)} 条的编号`}
                  value={item.id}
                  onChange={(e) => {
                    updateItem(index, { id: e.target.value });
                  }}
                />
              </TableCell>
              <TableCell className="align-top whitespace-normal">
                <Textarea
                  aria-label={`${label} 第 ${String(index + 1)} 条的判定标准`}
                  value={item.criterion}
                  className="min-h-9"
                  onChange={(e) => {
                    updateItem(index, { criterion: e.target.value });
                  }}
                />
              </TableCell>
              <TableCell className="align-top">
                <Input
                  aria-label={`${label} 第 ${String(index + 1)} 条的满分`}
                  type="number"
                  min={1}
                  step={1}
                  value={item.maxScore}
                  onChange={(e) => {
                    updateItem(index, { maxScore: e.target.valueAsNumber });
                  }}
                />
              </TableCell>
              <TableCell className="align-top">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`删除 ${label} 第 ${String(index + 1)} 条`}
                  disabled={group.items.length === 1}
                  onClick={() => {
                    onChange({ ...group, items: group.items.filter((_, i) => i !== index) });
                  }}
                >
                  <Trash2 />
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
        <TableFooter>
          <TableRow>
            <TableCell colSpan={2}>{label} 满分</TableCell>
            <TableCell colSpan={2}>{rubricMaxScore([group])}</TableCell>
          </TableRow>
        </TableFooter>
      </Table>
    </div>
  );
}

function DraftView({
  draft,
  onAdopt,
  onDiscard,
}: {
  draft: RubricDraft;
  onAdopt: () => void;
  onDiscard: () => void;
}) {
  return (
    <Card className="border-primary/40 bg-muted/30" data-testid="rubric-draft">
      <CardHeader>
        <CardTitle>LLM 草稿</CardTitle>
        <p className="text-sm text-muted-foreground">
          满分 {rubricMaxScore(draft.rubric)} · {draft.model} · 花费 ${draft.costUsd.toFixed(3)}
          。采纳后会替换下方的 rubric，保存前仍可修改。
        </p>
        <CardAction className="flex gap-2">
          <Button onClick={onAdopt}>采纳草稿</Button>
          <Button variant="outline" onClick={onDiscard}>
            放弃
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {draft.rubric.map((group) => (
          <div key={group.artifact} className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">
              {artifactLabels[group.artifact]}（满分 {rubricMaxScore([group])}）
            </h3>
            <Table className="table-fixed">
              <TableBody>
                {group.items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="w-16 align-top font-mono">{item.id}</TableCell>
                    <TableCell className="whitespace-normal">{item.criterion}</TableCell>
                    <TableCell className="w-12 text-right align-top">{item.maxScore}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function RubricEditor({ form, onChange }: { form: LfgForm; onChange: (form: LfgForm) => void }) {
  const [draft, setDraft] = useState<RubricDraft | null>(null);
  const drafting = useMutation({
    mutationFn: () =>
      draftRubric({
        id: form.id,
        kind: 'lfg',
        title: form.title,
        persona: form.persona,
        hiddenRequirements: form.hiddenRequirements,
        input: form.input,
      }),
    onSuccess: setDraft,
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Rubric</CardTitle>
        <p className="text-sm text-muted-foreground" data-testid="rubric-total">
          满分合计 {rubricMaxScore(form.rubric)}
        </p>
        <CardAction>
          <Button
            variant="outline"
            disabled={drafting.isPending}
            onClick={() => {
              drafting.mutate();
            }}
          >
            <Sparkles />
            {drafting.isPending ? '起草中，约需 30 秒…' : '让 LLM 起草 rubric'}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {drafting.isError && (
          <Alert variant="destructive">
            <AlertTitle>起草失败</AlertTitle>
            <AlertDescription>{drafting.error.message}</AlertDescription>
          </Alert>
        )}
        {draft && (
          <DraftView
            draft={draft}
            onAdopt={() => {
              onChange({ ...form, rubric: draft.rubric });
              setDraft(null);
            }}
            onDiscard={() => {
              setDraft(null);
            }}
          />
        )}
        {form.rubric.map((group, index) => (
          <RubricGroupEditor
            key={group.artifact}
            group={group}
            onChange={(next) => {
              onChange({
                ...form,
                rubric: form.rubric.map((g, i) => (i === index ? next : g)),
              });
            }}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function CriteriaEditor({
  criteria,
  onChange,
}: {
  criteria: string[];
  onChange: (criteria: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <Label>验收标准</Label>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            onChange([...criteria, '']);
          }}
        >
          <Plus />
          添加
        </Button>
      </div>
      {criteria.map((criterion, index) => (
        <div key={index} className="flex items-start gap-2">
          <Textarea
            aria-label={`验收标准第 ${String(index + 1)} 条`}
            value={criterion}
            className="min-h-9"
            onChange={(e) => {
              onChange(criteria.map((c, i) => (i === index ? e.target.value : c)));
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label={`删除验收标准第 ${String(index + 1)} 条`}
            disabled={criteria.length === 1}
            onClick={() => {
              onChange(criteria.filter((_, i) => i !== index));
            }}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
    </div>
  );
}

// requiredChecks 可以为空
function RequiredChecksEditor({
  checks,
  onChange,
}: {
  checks: string[];
  onChange: (checks: string[]) => void;
}) {
  return (
    <div className="flex flex-col gap-2" data-testid="required-checks">
      {checks.length === 0 && (
        <p className="text-sm text-muted-foreground">没有。终点只要求 PR 不是草稿。</p>
      )}
      {checks.map((check, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            aria-label={`required check 第 ${String(index + 1)} 个`}
            value={check}
            className="font-mono"
            onChange={(e) => {
              onChange(checks.map((c, i) => (i === index ? e.target.value : c)));
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label={`删除 required check 第 ${String(index + 1)} 个`}
            onClick={() => {
              onChange(checks.filter((_, i) => i !== index));
            }}
          >
            <Trash2 />
          </Button>
        </div>
      ))}
      <Button
        variant="outline"
        size="sm"
        className="w-fit"
        onClick={() => {
          onChange([...checks, '']);
        }}
      >
        <Plus />
        添加 check
      </Button>
    </div>
  );
}

function IcFields({
  form,
  onChange,
  initialAnalysis,
}: {
  form: IcForm;
  onChange: (form: IcForm) => void;
  initialAnalysis: WorkflowAnalysis | null;
}) {
  const [analysis, onAnalysis] = useState(initialAnalysis);
  const declared = (() => {
    const result = fromForm(form);
    return result.ok && result.task.kind === 'ic' && result.task.hiddenTests !== undefined
      ? Object.values(result.task.hiddenTests.manifest).flat().length
      : null;
  })();
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>工单</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <TextField
            label="工单标题"
            value={form.ticket.title}
            onChange={(title) => {
              onChange({ ...form, ticket: { ...form.ticket, title } });
            }}
          />
          <TextField
            label="工单正文"
            multiline
            rows={form.source === undefined ? 8 : 20}
            value={form.ticket.body}
            onChange={(body) => {
              onChange({ ...form, ticket: { ...form.ticket, body } });
            }}
          />
          <CriteriaEditor
            criteria={form.ticket.acceptanceCriteria}
            onChange={(acceptanceCriteria) => {
              onChange({ ...form, ticket: { ...form.ticket, acceptanceCriteria } });
            }}
          />
        </CardContent>
      </Card>
      {form.source === undefined ? (
        <Card>
          <CardHeader>
            <CardTitle>起始仓库</CardTitle>
            <p className="text-sm text-muted-foreground">bundle 的路径相对 task 目录。</p>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <TextField
              label="仓库 bundle"
              value={form.repo.path}
              onChange={(path) => {
                onChange({ ...form, repo: { ...form.repo, path } });
              }}
            />
            <TextField
              label="固定 commit"
              value={form.repo.commit}
              onChange={(commit) => {
                onChange({ ...form, repo: { ...form.repo, commit } });
              }}
            />
          </CardContent>
        </Card>
      ) : (
        <SourceRepoFields
          form={{ ...form, source: form.source }}
          analysis={analysis}
          onChange={onChange}
          onAnalysis={onAnalysis}
        />
      )}
      <Card>
        <CardHeader>
          <CardTitle>终点要求通过的 check</CardTitle>
          <p className="text-sm text-muted-foreground">
            副本仓库以这些 check 建 ruleset；终点为 PR 不是草稿且它们全部通过。为空时只要求 PR
            不是草稿。
          </p>
        </CardHeader>
        <CardContent>
          <RequiredChecksEditor
            checks={form.requiredChecks}
            onChange={(requiredChecks) => {
              onChange({ ...form, requiredChecks });
            }}
          />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <CardTitle>隐藏测试</CardTitle>
          <p className="text-sm text-muted-foreground">
            {form.hasHiddenTests
              ? '清单是评分的分母，键为测试文件相对仓库根目录的路径。'
              : '没有隐藏测试：judge 对照验收标准逐条评分。'}
          </p>
          <CardAction className="flex items-center gap-3">
            {declared !== null && <Badge variant="secondary">{declared} 个隐藏测试</Badge>}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.hasHiddenTests}
                onChange={(e) => {
                  onChange({ ...form, hasHiddenTests: e.target.checked });
                }}
              />
              有隐藏测试
            </label>
          </CardAction>
        </CardHeader>
        {form.hasHiddenTests && (
          <CardContent className="grid grid-cols-2 gap-4">
            <TextField
              label="隐藏测试目录"
              value={form.hiddenTests.dir}
              onChange={(dir) => {
                onChange({ ...form, hiddenTests: { ...form.hiddenTests, dir } });
              }}
            />
            <TextField
              label="测试命令"
              value={form.hiddenTests.command}
              onChange={(command) => {
                onChange({ ...form, hiddenTests: { ...form.hiddenTests, command } });
              }}
            />
            <TextField
              label="测试配置"
              value={form.hiddenTests.config}
              onChange={(config) => {
                onChange({ ...form, hiddenTests: { ...form.hiddenTests, config } });
              }}
            />
            <Field label="每一步的时限（秒）">
              {(id) => (
                <Input
                  id={id}
                  type="number"
                  min={1}
                  step={1}
                  value={form.hiddenTests.timeoutSeconds}
                  onChange={(e) => {
                    onChange({
                      ...form,
                      hiddenTests: { ...form.hiddenTests, timeoutSeconds: e.target.valueAsNumber },
                    });
                  }}
                />
              )}
            </Field>
            <div className="col-span-2">
              <TextField
                label="测试清单（YAML）"
                multiline
                rows={10}
                value={form.hiddenTests.manifestYaml}
                onChange={(manifestYaml) => {
                  onChange({ ...form, hiddenTests: { ...form.hiddenTests, manifestYaml } });
                }}
              />
            </div>
          </CardContent>
        )}
      </Card>
    </>
  );
}

export function TaskFormFields({
  form,
  onChange,
  idEditable,
  analysis = null,
}: {
  form: TaskForm;
  onChange: (form: TaskForm) => void;
  idEditable: boolean;
  // 从 Linear 导入时预览中的 workflow 分析
  analysis?: WorkflowAnalysis | null;
}) {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>基本信息</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <div className="grid grid-cols-2 gap-4">
            <TextField
              label="ID"
              value={form.id}
              disabled={!idEditable}
              onChange={(id) => {
                onChange({ ...form, id });
              }}
            />
            <TextField
              label="标题"
              value={form.title}
              onChange={(title) => {
                onChange({ ...form, title });
              }}
            />
          </div>
          {form.kind === 'lfg' && (
            <TextField
              label="交给 /lfg 的输入"
              value={form.input}
              onChange={(input) => {
                onChange({ ...form, input });
              }}
            />
          )}
          <TextField
            label="Persona（模拟用户扮演的人）"
            multiline
            rows={5}
            value={form.persona}
            onChange={(persona) => {
              onChange({ ...form, persona });
            }}
          />
          <TextField
            label="隐藏需求（只在被问到时透露）"
            multiline
            rows={12}
            value={form.hiddenRequirements}
            onChange={(hiddenRequirements) => {
              onChange({ ...form, hiddenRequirements });
            }}
          />
        </CardContent>
      </Card>
      {form.kind === 'lfg' ? (
        <RubricEditor form={form} onChange={onChange} />
      ) : (
        <IcFields form={form} onChange={onChange} initialAnalysis={analysis} />
      )}
    </div>
  );
}

export function IssuesAlert({ title, issues }: { title: string; issues: string[] }) {
  return (
    <Alert variant="destructive" data-testid="form-issues">
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <ul className="list-disc pl-4">
          {issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
