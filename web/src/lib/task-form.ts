import {
  type ArtifactRubric,
  type IcTaskDefinition,
  type LfgTaskDefinition,
  type RubricArtifact,
  rubricArtifacts,
  TaskDefinition,
} from '@wf-dashboard/server/tasks/schema';
import { parseDocument, stringify } from 'yaml';

export const artifactLabels: Record<RubricArtifact, string> = {
  brief: 'Brief',
  research: 'Research',
  plan: 'Plan',
  tickets: 'Tickets',
};

// 表单状态：ic 的清单以 YAML 文本编辑，保存时再解析
export type LfgForm = LfgTaskDefinition;
export type IcForm = Omit<IcTaskDefinition, 'hiddenTests'> & {
  hiddenTests: Omit<IcTaskDefinition['hiddenTests'], 'manifest'> & { manifestYaml: string };
};
export type TaskForm = LfgForm | IcForm;

export function toForm(task: TaskDefinition): TaskForm {
  if (task.kind === 'lfg') return task;
  const { manifest, ...hiddenTests } = task.hiddenTests;
  return { ...task, hiddenTests: { ...hiddenTests, manifestYaml: stringify(manifest) } };
}

export type FormResult = { ok: true; task: TaskDefinition } | { ok: false; issues: string[] };

export function fromForm(form: TaskForm): FormResult {
  let candidate: unknown = form;
  if (form.kind === 'ic') {
    const { manifestYaml, ...hiddenTests } = form.hiddenTests;
    // parseDocument 把语法错误放进 errors，输入中途的 YAML 不会抛出
    const doc = parseDocument(manifestYaml);
    if (doc.errors.length > 0) {
      return { ok: false, issues: doc.errors.map((e) => `测试清单：${e.message}`) };
    }
    candidate = { ...form, hiddenTests: { ...hiddenTests, manifest: doc.toJS() as unknown } };
  }
  const result = TaskDefinition.safeParse(candidate);
  if (result.success) return { ok: true, task: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((i) => `${i.path.join('.') || '（整体）'}：${i.message}`),
  };
}

export function emptyRubric(): ArtifactRubric[] {
  return rubricArtifacts.map((artifact) => ({
    artifact,
    items: [{ id: `${artifact[0] ?? ''}1`, criterion: '', maxScore: 3 }],
  }));
}
