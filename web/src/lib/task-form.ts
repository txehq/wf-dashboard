import {
  type ArtifactRubric,
  type IcHiddenTests,
  type IcTaskDefinition,
  type IcTaskDraft,
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

// 表单状态：ic 的清单以 YAML 文本编辑，保存时再解析；关闭隐藏测试时表单中保留填过的内容，保存时不写入
export type LfgForm = LfgTaskDefinition;
export type HiddenTestsForm = Omit<IcHiddenTests, 'manifest'> & { manifestYaml: string };
export type IcForm = Omit<IcTaskDefinition, 'hiddenTests'> & {
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

// 从 Linear 导入的预览：没有验收标准与正文时留空，由用户填写
export function icFormFromDraft(draft: IcTaskDraft): IcForm {
  return { ...draft, hasHiddenTests: false, hiddenTests: blankHiddenTests() };
}

export function toForm(task: TaskDefinition): TaskForm {
  if (task.kind === 'lfg') return task;
  if (task.hiddenTests === undefined) {
    return { ...task, hasHiddenTests: false, hiddenTests: blankHiddenTests() };
  }
  const { manifest, ...hiddenTests } = task.hiddenTests;
  return {
    ...task,
    hasHiddenTests: true,
    hiddenTests: { ...hiddenTests, manifestYaml: stringify(manifest) },
  };
}

export type FormResult = { ok: true; task: TaskDefinition } | { ok: false; issues: string[] };

export function fromForm(form: TaskForm): FormResult {
  let candidate: unknown = form;
  if (form.kind === 'ic') {
    const { hasHiddenTests, hiddenTests: hiddenForm, ...rest } = form;
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
