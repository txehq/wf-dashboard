import fs from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import type { DraftMode, LiveEngine } from '../db/schema.js';
import { claudeSessionDirsOf } from '../live/claude-session.js';
import { codexDirsOf } from '../live/codex.js';
import { readMcpServers } from '../variants/mcp.js';
import {
  DESIGN_WORKFLOW,
  isWfWorkflow,
  OPTIMIZE_WORKFLOW,
  type WorkflowDefinition,
} from '../workflows/schema.js';

// Draft dir (Contracts 17.2), also the session's working dir: for mode workflow and variant it is data/workflow-drafts/<draftId>/,
// with src/ and workflow.yaml in it; for mode optimize it is the analysis dir data/analyses/<analysisId>/, with both under optimize/ (19.3)
export function draftLayout(dir: string, mode: DraftMode) {
  const work = mode === 'optimize' ? path.join(dir, 'optimize') : dir;
  return {
    dir,
    src: path.join(work, 'src'),
    skills: path.join(work, 'src', 'skills'),
    workflowYaml: path.join(work, 'workflow.yaml'),
    platform: path.join(dir, 'PLATFORM.md'),
    // The skills of the workflow-design or workflow-optimize variant used go here (Contracts 33.2): Codex loads from
    // .agents/skills in its cwd, Claude Code from .claude/skills
    agentSkills: path.join(dir, '.agents', 'skills'),
    ...codexDirsOf(dir),
    ...claudeSessionDirsOf(dir),
  };
}
export type DraftLayout = ReturnType<typeof draftLayout>;

// Where in the working dir this engine loads project-scope skills from
export const sessionSkillsDir = (layout: DraftLayout, engine: LiveEngine) =>
  engine === 'codex' ? layout.agentSkills : layout.claudeSkills;

// Skill location written to PLATFORM.md (relative to the working dir)
const skillsPath = (engine: LiveEngine) =>
  engine === 'codex' ? '.agents/skills' : '.claude/skills';

const yamlHeader: Record<DraftMode, string> = {
  workflow: '# Definition of the new workflow: yours to change; saving uses it\n',
  variant:
    '# Read-only copy of the workflow definition: a new variant changes only the skill content in src/skills, not the entry or sub-stages\n',
  optimize:
    "# Copy of the analysed variant's workflow definition: when unchanged, saving makes a new variant of the original workflow; to create a new workflow, change it here (new id, name and sub-stages)\n",
};

// First preparation step: copySource copies the base variant src to src/. On retry the half-copied src/ is deleted first
export async function copyDraftSource(
  layout: DraftLayout,
  copySource: (dest: string) => Promise<void>,
) {
  fs.mkdirSync(path.dirname(layout.src), { recursive: true });
  fs.rmSync(layout.src, { recursive: true, force: true });
  await copySource(layout.src);
}

// This session's facts (Contracts 33.1): the methods are all in the workflow-design and workflow-optimize skills
export interface DraftFacts {
  mode: DraftMode;
  engine: LiveEngine;
  definition: WorkflowDefinition;
  // Base variant; null for a new workflow started from blank
  base: { id: string; name: string } | null;
  // The analysis, for mode optimize
  analysisId: string | null;
}

const modeLine: Record<DraftMode, string> = {
  workflow: 'Design workflow: a new workflow (saving yields a new workflow and its first variant)',
  variant:
    'Design workflow: a new variant of an existing workflow (entry and sub-stages are fixed; change only skill content)',
  optimize: 'Optimize: change the variant following the analysis report, or derive a new workflow',
};

export function platformFacts(layout: DraftLayout, facts: DraftFacts): string {
  const { mode, definition } = facts;
  const rel = (p: string) => path.relative(layout.dir, p);
  const servers = Object.keys(readMcpServers(layout.src));
  const lines = [
    '# This session',
    '',
    `- Session: ${modeLine[mode]}`,
    `- Entry skill: ${mode === 'optimize' ? OPTIMIZE_WORKFLOW : DESIGN_WORKFLOW} (in \`${skillsPath(facts.engine)}/\`, together with writing-for-agents, skill-creator and find-skills)`,
    `- Workflow: \`${definition.id}\` (${definition.name})`,
    `- Build: ${isWfWorkflow(definition.id) ? 'wf (`src/` is a complete txe-workflow export)' : 'dashboard (`src/skills/` is everything)'}`,
    facts.base === null
      ? '- Base variant: none; `src/skills/` holds skeletons of the entry and each sub-stage'
      : `- ${mode === 'optimize' ? 'Analysed variant' : 'Base variant'}: ${facts.base.name} (\`${facts.base.id}\`)`,
    ...(facts.analysisId === null
      ? []
      : [
          `- Analysis: \`${facts.analysisId}\`; \`input/\` holds the analysed sessions and skills (read-only), \`output/\` the analysis results`,
        ]),
    `- \`${rel(layout.src)}/\`: where you write skills`,
    `- \`${rel(layout.workflowYaml)}\`: ${mode === 'variant' ? 'the workflow definition, read-only' : 'you may change it'}`,
    '- Trial run files: `trial/`',
    `- MCP servers loaded in this session: ${servers.length === 0 ? 'none' : `${servers.join(', ')} (from \`${rel(layout.src)}/mcp.json\`)`}`,
    '',
  ];
  return lines.join('\n');
}

// Second preparation step: workflow.yaml and PLATFORM.md; rewritten whole on retry
export function writeDraftDocs(layout: DraftLayout, facts: DraftFacts) {
  fs.rmSync(layout.workflowYaml, { force: true });
  fs.writeFileSync(layout.workflowYaml, yamlHeader[facts.mode] + stringify(facts.definition));
  if (facts.mode === 'variant') fs.chmodSync(layout.workflowYaml, 0o444);
  fs.writeFileSync(layout.platform, platformFacts(layout, facts));
}

// How to invoke the entry skill (Contracts 33.2): /<skill> for Claude Code, $<skill> for Codex
const invoke = (engine: LiveEngine, skill: string) => `${engine === 'codex' ? '$' : '/'}${skill}`;

// Initial message of a design session: invoke workflow-design with the requirement text and where PLATFORM.md is
export function initialMessage(requirement: string, engine: LiveEngine): string {
  return `${invoke(engine, DESIGN_WORKFLOW)} ${requirement}\n\nThis session's facts are in PLATFORM.md.`;
}

// Initial message of an optimize session: invoke workflow-optimize with where the report and PLATFORM.md are
export function optimizeMessage(input: {
  analysisId: string;
  workflowId: string;
  variantName: string;
  engine: LiveEngine;
}): string {
  return `${invoke(input.engine, OPTIMIZE_WORKFLOW)} Optimize variant "${input.variantName}" of workflow ${input.workflowId} following the report of analysis ${input.analysisId}: the report is in output/report.json, and this session's facts are in PLATFORM.md.`;
}
