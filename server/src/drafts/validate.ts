import fs from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { HttpError } from '../variants/errors.js';
import { readMcpServers } from '../variants/mcp.js';
import { skillsProblem } from '../variants/skills.js';
import { parseDefinition } from '../workflows/index.js';
import { requiredSkills, type WorkflowDefinition } from '../workflows/schema.js';
import type { DraftLayout } from './dir.js';

// 保存前的校验（Contracts 17.4）：不通过时以原文 400，草稿不动

// workflow.yaml 是合法的 YAML 并符合 16.1 的 schema
export function readDraftDefinition(layout: DraftLayout): WorkflowDefinition {
  if (!fs.existsSync(layout.workflowYaml)) {
    throw new HttpError(400, `草稿中没有 workflow.yaml：${layout.workflowYaml}`);
  }
  const doc = parseDocument(fs.readFileSync(layout.workflowYaml, 'utf8'));
  if (doc.errors.length > 0) {
    throw new HttpError(
      400,
      `workflow.yaml 不是合法的 YAML：${doc.errors.map((e) => e.message).join('；')}`,
    );
  }
  return parseDefinition(doc.toJS(), 'workflow.yaml');
}

// 入口 skill 与每个小阶段的 skill 都在 src/skills/ 中，每个 SKILL.md 有合法的 frontmatter
export function checkDraftSkills(layout: DraftLayout, definition: WorkflowDefinition) {
  const missing = requiredSkills(definition).filter(
    (name) => !fs.existsSync(path.join(layout.skills, name, 'SKILL.md')),
  );
  if (missing.length > 0) {
    throw new HttpError(
      400,
      `src/skills/ 中缺少 workflow ${definition.id} 要求的 skill：${missing.join('、')}（应为 src/skills/<名字>/SKILL.md）`,
    );
  }
  const problem = skillsProblem(layout.skills);
  if (problem !== null) throw new HttpError(400, problem);
  // src/mcp.json 符合 .mcp.json 的格式（Contracts 28.1）
  readMcpServers(layout.src);
}
