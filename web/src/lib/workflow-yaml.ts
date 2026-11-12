import { WorkflowDefinition } from '@wf-dashboard/server/workflows/schema';
import { LineCounter, parseDocument, stringify } from 'yaml';

// One problem in a definition: lines start at 1; 1 when there is no matching position
export interface DefinitionIssue {
  line: number;
  message: string;
}

export type ParsedDefinition =
  { ok: true; definition: WorkflowDefinition } | { ok: false; issues: DefinitionIssue[] };

export const definitionYaml = (definition: WorkflowDefinition) =>
  stringify(definition, { lineWidth: 0 });

// YAML text -> definition: syntax errors and zod issues both carry their line in the YAML (Contracts 16.7)
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
      // The deepest node on the issue path that exists in the YAML
      let range: [number, number, number] | undefined;
      for (let n = issue.path.length; n >= 0 && range === undefined; n--) {
        const node = doc.getIn(issue.path.slice(0, n) as (string | number)[], true) as
          { range?: [number, number, number] } | undefined;
        range = node?.range;
      }
      const where = issue.path.length === 0 ? '' : `${issue.path.join('.')}: `;
      return {
        line: range === undefined ? 1 : lineCounter.linePos(range[0]).line,
        message: `${where}${issue.message}`,
      };
    }),
  };
}
