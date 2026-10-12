import { WorkflowDefinition } from '@wf-dashboard/server/workflows/schema';
import { LineCounter, parseDocument, stringify } from 'yaml';

// 定义的一处问题：行号从 1 开始，没有对应位置时为 1
export interface DefinitionIssue {
  line: number;
  message: string;
}

export type ParsedDefinition =
  { ok: true; definition: WorkflowDefinition } | { ok: false; issues: DefinitionIssue[] };

export const definitionYaml = (definition: WorkflowDefinition) =>
  stringify(definition, { lineWidth: 0 });

// YAML 文本 → 定义：语法错误与 zod 的问题都带上 YAML 中对应的行（Contracts 16.7）
export function parseDefinitionYaml(text: string): ParsedDefinition {
  const lineCounter = new LineCounter();
  const doc = parseDocument(text, { lineCounter });
  if (doc.errors.length > 0) {
    return {
      ok: false,
      issues: doc.errors.map((e) => ({ line: e.linePos?.[0].line ?? 1, message: e.message })),
    };
  }
  const result = WorkflowDefinition.safeParse(doc.toJS());
  if (result.success) return { ok: true, definition: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => {
      // 取问题路径上最深的、在 YAML 中存在的节点
      let range: [number, number, number] | undefined;
      for (let n = issue.path.length; n >= 0 && range === undefined; n--) {
        const node = doc.getIn(issue.path.slice(0, n) as (string | number)[], true) as
          { range?: [number, number, number] } | undefined;
        range = node?.range;
      }
      const where = issue.path.length === 0 ? '' : `${issue.path.join('.')}：`;
      return {
        line: range === undefined ? 1 : lineCounter.linePos(range[0]).line,
        message: `${where}${issue.message}`,
      };
    }),
  };
}
