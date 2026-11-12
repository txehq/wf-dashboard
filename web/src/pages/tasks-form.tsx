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
import { artifactLabel, fromForm, type IcForm, type LfgForm, type TaskForm } from '@/lib/task-form';
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
  const label = artifactLabel(group.artifact);
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
          Add item
        </Button>
      </div>
      <Table className="table-fixed">
        <TableHeader>
          <TableRow>
            <TableHead className="w-24">ID</TableHead>
            <TableHead>Criterion</TableHead>
            <TableHead className="w-24">Max score</TableHead>
            <TableHead className="w-12">
              <span className="sr-only">Delete</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {group.items.map((item, index) => (
            <TableRow key={index}>
              <TableCell className="align-top">
                <Input
                  aria-label={`${label} item ${String(index + 1)} ID`}
                  value={item.id}
                  onChange={(e) => {
                    updateItem(index, { id: e.target.value });
                  }}
                />
              </TableCell>
              <TableCell className="align-top whitespace-normal">
                <Textarea
                  aria-label={`${label} item ${String(index + 1)} criterion`}
                  value={item.criterion}
                  className="min-h-9"
                  onChange={(e) => {
                    updateItem(index, { criterion: e.target.value });
                  }}
                />
              </TableCell>
              <TableCell className="align-top">
                <Input
                  aria-label={`${label} item ${String(index + 1)} max score`}
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
                  aria-label={`Delete ${label} item ${String(index + 1)}`}
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
            <TableCell colSpan={2}>{label} max score</TableCell>
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
        <CardTitle>LLM draft</CardTitle>
        <p className="text-sm text-muted-foreground">
          Max score {rubricMaxScore(draft.rubric)} · {draft.model} · cost $
          {draft.costUsd.toFixed(3)}. Adopting replaces the rubric below; you can still edit it
          before saving.
        </p>
        <CardAction className="flex gap-2">
          <Button onClick={onAdopt}>Adopt draft</Button>
          <Button variant="outline" onClick={onDiscard}>
            Discard
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {draft.rubric.map((group) => (
          <div key={group.artifact} className="flex flex-col gap-1">
            <h3 className="text-sm font-semibold">
              {artifactLabel(group.artifact)} (max {rubricMaxScore([group])})
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
        kind: form.kind,
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
          Total max score {rubricMaxScore(form.rubric)}
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
            {drafting.isPending ? 'Drafting, about 30s…' : 'Draft rubric with LLM'}
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {drafting.isError && (
          <Alert variant="destructive">
            <AlertTitle>Could not draft</AlertTitle>
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
        <Label>Acceptance criteria</Label>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            onChange([...criteria, '']);
          }}
        >
          <Plus />
          Add
        </Button>
      </div>
      {criteria.map((criterion, index) => (
        <div key={index} className="flex items-start gap-2">
          <Textarea
            aria-label={`Acceptance criterion ${String(index + 1)}`}
            value={criterion}
            className="min-h-9"
            onChange={(e) => {
              onChange(criteria.map((c, i) => (i === index ? e.target.value : c)));
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Delete acceptance criterion ${String(index + 1)}`}
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

// requiredChecks may be empty
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
        <p className="text-sm text-muted-foreground">
          None. The endpoint only requires the PR to not be a draft.
        </p>
      )}
      {checks.map((check, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            aria-label={`Required check ${String(index + 1)}`}
            value={check}
            className="font-mono"
            onChange={(e) => {
              onChange(checks.map((c, i) => (i === index ? e.target.value : c)));
            }}
          />
          <Button
            variant="ghost"
            size="icon"
            aria-label={`Delete required check ${String(index + 1)}`}
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
        Add check
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
    return result.ok && result.task.hiddenTests !== undefined
      ? Object.values(result.task.hiddenTests.manifest).flat().length
      : null;
  })();
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>Ticket</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <TextField
            label="Ticket title"
            value={form.ticket.title}
            onChange={(title) => {
              onChange({ ...form, ticket: { ...form.ticket, title } });
            }}
          />
          <TextField
            label="Ticket body"
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
            <CardTitle>Starting repo</CardTitle>
            <p className="text-sm text-muted-foreground">
              The bundle path is relative to the task folder.
            </p>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-4">
            <TextField
              label="Repo bundle"
              value={form.repo.path}
              onChange={(path) => {
                onChange({ ...form, repo: { ...form.repo, path } });
              }}
            />
            <TextField
              label="Pinned commit"
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
          <CardTitle>Checks required at the endpoint</CardTitle>
          <p className="text-sm text-muted-foreground">
            The copy repo gets a ruleset with these checks. The endpoint is reached when the PR is
            not a draft and all of them pass. When empty, the PR only needs to not be a draft.
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
          <CardTitle>Hidden tests</CardTitle>
          <p className="text-sm text-muted-foreground">
            {form.hasHiddenTests
              ? 'The manifest is the grading denominator. Keys are test file paths relative to the repo root.'
              : 'No hidden tests: the judge scores each acceptance criterion.'}
          </p>
          <CardAction className="flex items-center gap-3">
            {declared !== null && (
              <Badge variant="secondary">
                {declared} {declared === 1 ? 'hidden test' : 'hidden tests'}
              </Badge>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={form.hasHiddenTests}
                onChange={(e) => {
                  onChange({ ...form, hasHiddenTests: e.target.checked });
                }}
              />
              Has hidden tests
            </label>
          </CardAction>
        </CardHeader>
        {form.hasHiddenTests && (
          <CardContent className="grid grid-cols-2 gap-4">
            <TextField
              label="Hidden tests folder"
              value={form.hiddenTests.dir}
              onChange={(dir) => {
                onChange({ ...form, hiddenTests: { ...form.hiddenTests, dir } });
              }}
            />
            <TextField
              label="Test command"
              value={form.hiddenTests.command}
              onChange={(command) => {
                onChange({ ...form, hiddenTests: { ...form.hiddenTests, command } });
              }}
            />
            <TextField
              label="Test config"
              value={form.hiddenTests.config}
              onChange={(config) => {
                onChange({ ...form, hiddenTests: { ...form.hiddenTests, config } });
              }}
            />
            <Field label="Time limit per step (seconds)">
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
                label="Test manifest (YAML)"
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
  // Workflow analysis from the preview when importing from Linear
  analysis?: WorkflowAnalysis | null;
}) {
  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Basics</CardTitle>
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
              label="Title"
              value={form.title}
              onChange={(title) => {
                onChange({ ...form, title });
              }}
            />
          </div>
          {form.kind === 'lfg' && (
            <TextField
              label="Input to /lfg"
              value={form.input}
              onChange={(input) => {
                onChange({ ...form, input });
              }}
            />
          )}
          <TextField
            label="Persona (who the simulated user plays)"
            multiline
            rows={5}
            value={form.persona}
            onChange={(persona) => {
              onChange({ ...form, persona });
            }}
          />
          <TextField
            label="Hidden requirements (revealed only when asked)"
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
