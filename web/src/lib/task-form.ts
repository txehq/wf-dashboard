import {
  type ArtifactRubric,
  type HiddenTests,
  type TaskDraft,
  TaskDefinition,
  type Ticket,
  type TaskRepo,
} from '@wf-dashboard/server/tasks/schema';
import { parseDocument, stringify } from 'yaml';

// lfg rubric groups (Contracts 16.2)
const lfgRubricArtifacts = ['brief', 'research', 'plan', 'tickets'];

const artifactNames: Record<string, string> = {
  brief: 'Brief',
  research: 'Research',
  plan: 'Plan',
  tickets: 'Tickets',
};

// Rubric group display names: the four lfg groups have fixed names, others show their id
export const artifactLabel = (artifact: string) => artifactNames[artifact] ?? artifact;

// Form state: two field sets by task kind (lfg with a rubric, ic with a ticket and repo);
// the ic manifest is edited as YAML and parsed on save; with hidden tests off, filled-in values stay in the form but are not saved
export type LfgForm = TaskDefinition & { kind: 'lfg'; input: string; rubric: ArtifactRubric[] };
export type HiddenTestsForm = Omit<HiddenTests, 'manifest'> & { manifestYaml: string };
export type IcForm = Omit<TaskDefinition, 'hiddenTests'> & {
  kind: 'ic';
  ticket: Ticket;
  repo: TaskRepo;
  requiredChecks: string[];
  hasHiddenTests: boolean;
  hiddenTests: HiddenTestsForm;
};
export type TaskForm = LfgForm | IcForm;

export function blankHiddenTests(): HiddenTestsForm {
  return {
    dir: 'hidden-tests',
    config: 'vitest.hidden.config.mjs',
    command:
      'npx vitest run test/hidden --config {configPath} --reporter=junit --outputFile.junit={junitPath}',
    timeoutSeconds: 600,
    manifestYaml: '',
  };
}

function icFields(task: TaskDefinition) {
  const { ticket, repo, requiredChecks } = task;
  if (ticket === undefined || repo === undefined || requiredChecks === undefined) {
    throw new Error(`task ${task.id} has no ticket, repo or requiredChecks`);
  }
  return { ticket, repo, requiredChecks };
}

// Preview imported from Linear: acceptance criteria and body stay empty when missing, for the user to fill in
export function icFormFromDraft(draft: TaskDraft): IcForm {
  const { repo, requiredChecks } = draft;
  if (repo === undefined || requiredChecks === undefined) {
    throw new Error(`imported task ${draft.id} has no repo or requiredChecks`);
  }
  return {
    ...draft,
    repo,
    requiredChecks,
    kind: 'ic',
    hasHiddenTests: false,
    hiddenTests: blankHiddenTests(),
  };
}

export function toForm(task: TaskDefinition): TaskForm {
  if (task.kind === 'lfg') {
    if (task.input === undefined || task.rubric === undefined) {
      throw new Error(`task ${task.id} has no input or rubric`);
    }
    return { ...task, kind: 'lfg', input: task.input, rubric: task.rubric };
  }
  const { hiddenTests: tests, ...rest } = task;
  const base = { ...rest, ...icFields(task), kind: 'ic' as const };
  if (tests === undefined)
    return { ...base, hasHiddenTests: false, hiddenTests: blankHiddenTests() };
  const { manifest, ...hiddenTests } = tests;
  return {
    ...base,
    hasHiddenTests: true,
    hiddenTests: { ...hiddenTests, manifestYaml: stringify(manifest) },
  };
}

export type FormResult = { ok: true; task: TaskDefinition } | { ok: false; issues: string[] };

export function fromForm(form: TaskForm): FormResult {
  let candidate: unknown;
  if (form.kind === 'ic') {
    const { hasHiddenTests, hiddenTests: hiddenForm, ...rest } = form;
    if (!hasHiddenTests) {
      candidate = rest;
    } else {
      const { manifestYaml, ...hiddenTests } = hiddenForm;
      // parseDocument puts syntax errors in errors, so half-typed YAML does not throw
      const doc = parseDocument(manifestYaml);
      if (doc.errors.length > 0) {
        return { ok: false, issues: doc.errors.map((e) => `Test manifest: ${e.message}`) };
      }
      candidate = { ...rest, hiddenTests: { ...hiddenTests, manifest: doc.toJS() as unknown } };
    }
  } else {
    candidate = form;
  }
  const result = TaskDefinition.safeParse(candidate);
  if (result.success) return { ok: true, task: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}

export function emptyRubric(): ArtifactRubric[] {
  return lfgRubricArtifacts.map((artifact) => ({
    artifact,
    items: [{ id: `${artifact[0] ?? ''}1`, criterion: '', maxScore: 3 }],
  }));
}
