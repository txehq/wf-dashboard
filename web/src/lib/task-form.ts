import {
  type ArtifactRubric,
  type HiddenTests,
  type TaskDraft,
  TaskDefinition,
  type Ticket,
  type TaskRepo,
} from '@wf-dashboard/server/tasks/schema';
import { parseDocument, stringify } from 'yaml';

// dev-workflow 的 lfg 的 rubric 分组（新的按 workflow 与大阶段生成的表单由 W37 做）
const devRubricArtifacts = ['brief', 'research', 'plan', 'tickets'];

const artifactNames: Record<string, string> = {
  brief: 'Brief',
  research: 'Research',
  plan: 'Plan',
  tickets: 'Tickets',
};

// rubric 分组的显示名：dev-workflow 的四组用固定名字，其他 workflow 的分组显示 id
export const artifactLabel = (artifact: string) => artifactNames[artifact] ?? artifact;

// 表单状态：kind 只在表单中区分两种字段组（有 rubric 的大阶段与有工单、仓库的大阶段），保存时去掉；
// ic 的清单以 YAML 文本编辑，保存时再解析；关闭隐藏测试时表单中保留填过的内容，保存时不写入
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
    throw new Error(`task ${task.id} 没有工单、仓库或 requiredChecks`);
  }
  return { ticket, repo, requiredChecks };
}

// 从 Linear 导入的预览：没有验收标准与正文时留空，由用户填写
export function icFormFromDraft(draft: TaskDraft): IcForm {
  const { repo, requiredChecks } = draft;
  if (repo === undefined || requiredChecks === undefined) {
    throw new Error(`导入的 task ${draft.id} 没有仓库或 requiredChecks`);
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
  if (task.rubric !== undefined) {
    if (task.input === undefined) throw new Error(`task ${task.id} 没有 input`);
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

// 表单的 kind 不属于 task 定义，保存前去掉
function withoutKind<T extends { kind: string }>(value: T): Omit<T, 'kind'> {
  const copy: Partial<T> = { ...value };
  delete copy.kind;
  return copy as Omit<T, 'kind'>;
}

export function fromForm(form: TaskForm): FormResult {
  let candidate: unknown;
  if (form.kind === 'ic') {
    const { hasHiddenTests, hiddenTests: hiddenForm, ...rest } = withoutKind(form);
    if (!hasHiddenTests) {
      candidate = rest;
    } else {
      const { manifestYaml, ...hiddenTests } = hiddenForm;
      // parseDocument 把语法错误放进 errors，输入中途的 YAML 不会抛出
      const doc = parseDocument(manifestYaml);
      if (doc.errors.length > 0) {
        return { ok: false, issues: doc.errors.map((e) => `测试清单：${e.message}`) };
      }
      candidate = { ...rest, hiddenTests: { ...hiddenTests, manifest: doc.toJS() as unknown } };
    }
  } else {
    candidate = withoutKind(form);
  }
  const result = TaskDefinition.safeParse(candidate);
  if (result.success) return { ok: true, task: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((i) => `${i.path.join('.') || '（整体）'}：${i.message}`),
  };
}

export function emptyRubric(): ArtifactRubric[] {
  return devRubricArtifacts.map((artifact) => ({
    artifact,
    items: [{ id: `${artifact[0] ?? ''}1`, criterion: '', maxScore: 3 }],
  }));
}
