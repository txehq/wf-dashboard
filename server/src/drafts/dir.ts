import fs from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { config } from '../config.js';
import type { AnalysisReport, DraftMode, LiveEngine } from '../db/schema.js';
import { claudeSessionDirsOf } from '../live/claude-session.js';
import { codexDirsOf } from '../live/codex.js';
import { isWfWorkflow, type WorkflowDefinition } from '../workflows/schema.js';

// dashboard 自带的 PLATFORM.md 与例子 workflow；pnpm start 运行 dist 时同样从源码目录读取
const assetsDir = path.join(config.repoRoot, 'server/src/drafts/assets');

// dashboard 自带的 skill：怎样查本机可用的 MCP、怎样写进 src/mcp.json（Contracts 28.1）
export const PLATFORM_MCP_SKILL = 'platform-mcp';

// 草稿目录（Contracts 17.2），也是 Codex 的工作目录：mode 为 workflow、variant 时是 data/workflow-drafts/<draftId>/，
// src/ 与 workflow.yaml 在目录下；mode 为 optimize 时是分析目录 data/analyses/<analysisId>/，两者在 optimize/ 下（19.3）
export function draftLayout(dir: string, mode: DraftMode) {
  const work = mode === 'optimize' ? path.join(dir, 'optimize') : dir;
  return {
    dir,
    src: path.join(work, 'src'),
    skills: path.join(work, 'src', 'skills'),
    workflowYaml: path.join(work, 'workflow.yaml'),
    platform: path.join(dir, 'PLATFORM.md'),
    example: path.join(dir, 'examples', 'simple-workflow'),
    // find-skills 等装到这里（Contracts 17.3），Codex 从 cwd 的 .agents/skills 加载；Claude Code 的会话装到
    // .claude/skills（22.2）
    agentSkills: path.join(dir, '.agents', 'skills'),
    skillsLock: path.join(dir, 'skills-lock.json'),
    ...codexDirsOf(dir),
    ...claudeSessionDirsOf(dir),
  };
}
export type DraftLayout = ReturnType<typeof draftLayout>;

// 这个引擎从工作目录中的哪里加载项目范围的 skill
export const sessionSkillsDir = (layout: DraftLayout, engine: LiveEngine) =>
  engine === 'codex' ? layout.agentSkills : layout.claudeSkills;

// 写进初始消息的 skill 位置（相对工作目录）
const skillsPath = (engine: LiveEngine) =>
  engine === 'codex' ? '.agents/skills' : '.claude/skills';

const yamlHeader: Record<DraftMode, string> = {
  workflow: '# 新 workflow 的定义（结构见 PLATFORM.md）：由你修改；保存时以它为准\n',
  variant:
    '# 所属 workflow 的定义，只读副本：新 variant 只改 src/skills 中的 skill 内容，不改入口与小阶段\n',
  optimize:
    '# 被分析 variant 所属 workflow 的定义副本：与原定义相同时保存为原 workflow 的新 variant；需要新建 workflow 时改这里（新的 id、名字与小阶段）\n',
};

// 准备的第一步：底子 variant 的 src 由 copySource 复制到 src/。重试时先删去上次复制了一半的 src/
export async function copyDraftSource(
  layout: DraftLayout,
  copySource: (dest: string) => Promise<void>,
) {
  fs.mkdirSync(path.dirname(layout.src), { recursive: true });
  fs.rmSync(layout.src, { recursive: true, force: true });
  await copySource(layout.src);
}

// 准备的第二步：workflow.yaml、PLATFORM.md、例子 workflow 与 platform-mcp；重试时整体重写。
// 内置 lfg、ic 之下的 variant 用 wf 构建，说明为 PLATFORM.md；其余由 dashboard 自己管理（Contracts 18.6）。
// mode 为 optimize 时说明后加上 variant 与 workflow 的界限（19.1）。platform-mcp 与三个工具 skill 装在一起（28.1）
export function writeDraftDocs(
  layout: DraftLayout,
  mode: DraftMode,
  definition: WorkflowDefinition,
  engine: LiveEngine,
) {
  fs.rmSync(layout.workflowYaml, { force: true });
  fs.writeFileSync(layout.workflowYaml, yamlHeader[mode] + stringify(definition));
  if (mode === 'variant') fs.chmodSync(layout.workflowYaml, 0o444);
  const platform = isWfWorkflow(definition.id) ? 'PLATFORM.md' : 'PLATFORM-own.md';
  const text = fs.readFileSync(path.join(assetsDir, platform), 'utf8');
  fs.writeFileSync(
    layout.platform,
    mode === 'optimize'
      ? `${text}\n${fs.readFileSync(path.join(assetsDir, 'PLATFORM-optimize.md'), 'utf8')}`
      : text,
  );
  fs.rmSync(layout.example, { recursive: true, force: true });
  fs.cpSync(path.join(assetsDir, 'simple-workflow'), layout.example, { recursive: true });
  const mcpSkill = path.join(sessionSkillsDir(layout, engine), PLATFORM_MCP_SKILL);
  fs.rmSync(mcpSkill, { recursive: true, force: true });
  fs.cpSync(path.join(assetsDir, PLATFORM_MCP_SKILL), mcpSkill, { recursive: true });
}

// 两种初始消息共同的最后一行：MCP 与试跑（Contracts 28.1、28.2）
const toolsLine = (skills: string) =>
  `workflow 要用 MCP 服务器时用 ${skills}/${PLATFORM_MCP_SKILL}。src/skills/ 中的 skill 随写随装进这个会话，可以在这个终端中用 /<入口> 试跑（见 PLATFORM.md 的"试跑"）。`;

// 初始消息（Contracts 17.3、22.2）：需求原文，加读什么、写到哪里、用哪些 skill；两种引擎相同，只有 skill 的位置不同
export function initialMessage(
  mode: 'workflow' | 'variant',
  requirement: string,
  engine: LiveEngine,
): string {
  const skills = skillsPath(engine);
  const target =
    mode === 'workflow'
      ? '这是一个新 workflow：在 src/skills/ 中写入口 skill 与每个小阶段的 skill，并按需要修改 workflow.yaml 的小阶段。'
      : '这是已有 workflow 的一个新 variant：入口与小阶段已定（workflow.yaml 只读），只在 src/skills/ 中修改 skill 的内容。';
  return [
    requirement,
    '',
    '---',
    '先读 PLATFORM.md 与 examples/simple-workflow/。',
    target,
    `写 skill 时使用 ${skills}/writing-for-agents 与 ${skills}/skill-creator；需要现成的 skill 时用 ${skills}/find-skills（只用项目范围，装进本目录的 ${skills}/）。`,
    toolsLine(skills),
  ].join('\n');
}

// 交给 agent 优化的初始消息（Contracts 19.3）：报告的总结与发现的条数，指向 output/ 与 optimize/
export function optimizeMessage(input: {
  analysisId: string;
  workflowId: string;
  variantName: string;
  report: AnalysisReport;
  findings: { high: number; medium: number; low: number };
  patches: number;
  engine: LiveEngine;
}): string {
  const { report, findings } = input;
  const skills = skillsPath(input.engine);
  return [
    `分析 ${input.analysisId} 分析了 workflow ${input.workflowId} 的 variant「${input.variantName}」，报告的总结：`,
    '',
    report.summary,
    '',
    `发现 ${String(findings.high + findings.medium + findings.low)} 条（high ${String(findings.high)}、medium ${String(findings.medium)}、low ${String(findings.low)}），skill 的修改建议 ${String(input.patches)} 个，需要新建 workflow 的建议 ${String(report.workflowChanges.length)} 条。`,
    '',
    '---',
    `用 ${skills}/optimize-from-report 完成这次优化：先读 PLATFORM.md，再读 output/report.json、output/findings-*.json 与 output/patches.json，判断改 variant 还是新建 workflow，然后在 optimize/src/skills/（新建 workflow 时还有 optimize/workflow.yaml）中把改动做出来。`,
    `写 skill 时使用 ${skills}/writing-for-agents 与 ${skills}/skill-creator；需要现成的 skill 时用 ${skills}/find-skills（只用项目范围，装进本目录的 ${skills}/）。`,
    toolsLine(skills),
  ].join('\n');
}
