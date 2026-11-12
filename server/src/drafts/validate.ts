import fs from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { HttpError } from '../variants/errors.js';
import { readMcpServers } from '../variants/mcp.js';
import { skillsProblem } from '../variants/skills.js';
import { parseDefinition } from '../workflows/index.js';
import { requiredSkills, type WorkflowDefinition } from '../workflows/schema.js';
import type { DraftLayout } from './dir.js';

// Validation before saving (Contracts 17.4): failures are a 400 with the original text; the draft is untouched

// workflow.yaml is valid YAML and matches the 16.1 schema
export function readDraftDefinition(layout: DraftLayout): WorkflowDefinition {
  if (!fs.existsSync(layout.workflowYaml)) {
    throw new HttpError(400, `The draft has no workflow.yaml: ${layout.workflowYaml}`);
  }
  const doc = parseDocument(fs.readFileSync(layout.workflowYaml, 'utf8'));
  if (doc.errors.length > 0) {
    throw new HttpError(
      400,
      `workflow.yaml is not valid YAML: ${doc.errors.map((e) => e.message).join('; ')}`,
    );
  }
  return parseDefinition(doc.toJS(), 'workflow.yaml');
}

// The entry skill and every sub-stage skill are in src/skills/, and each SKILL.md has valid frontmatter
export function checkDraftSkills(layout: DraftLayout, definition: WorkflowDefinition) {
  const missing = requiredSkills(definition).filter(
    (name) => !fs.existsSync(path.join(layout.skills, name, 'SKILL.md')),
  );
  if (missing.length > 0) {
    throw new HttpError(
      400,
      `src/skills/ is missing skills required by workflow ${definition.id}: ${missing.join(', ')} (expected src/skills/<name>/SKILL.md)`,
    );
  }
  const problem = skillsProblem(layout.skills);
  if (problem !== null) throw new HttpError(400, problem);
  // src/mcp.json matches the .mcp.json format (Contracts 28.1)
  readMcpServers(layout.src);
}
