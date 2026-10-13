import fs from 'node:fs';
import path from 'node:path';
import { stringify } from 'yaml';
import { config } from '../config.js';
import type { DraftMode } from '../db/schema.js';
import { codexDirsOf } from '../live/codex.js';
import { isBuiltinWorkflow, type WorkflowDefinition } from '../workflows/schema.js';

// dashboard 自带的 PLATFORM.md 与例子 workflow；pnpm start 运行 dist 时同样从源码目录读取
const assetsDir = path.join(config.repoRoot, 'server/src/drafts/assets');

// 草稿目录 data/workflow-drafts/<draftId>/（Contracts 17.2），也是 Codex 的工作目录
export function draftLayout(dir: string) {
  return {
    dir,
    src: path.join(dir, 'src'),
    skills: path.join(dir, 'src', 'skills'),
    workflowYaml: path.join(dir, 'workflow.yaml'),
    platform: path.join(dir, 'PLATFORM.md'),
    example: path.join(dir, 'examples', 'simple-workflow'),
    // find-skills 等装到这里（Contracts 17.3），Codex 从 cwd 的 .agents/skills 加载
    agentSkills: path.join(dir, '.agents', 'skills'),
    skillsLock: path.join(dir, 'skills-lock.json'),
    ...codexDirsOf(dir),
  };
}
export type DraftLayout = ReturnType<typeof draftLayout>;

const yamlHeader: Record<DraftMode, string> = {
  workflow: '# 新 workflow 的定义（结构见 PLATFORM.md）：由你修改；保存时以它为准\n',
  variant:
    '# 所属 workflow 的定义，只读副本：新 variant 只改 src/skills 中的 skill 内容，不改入口与小阶段\n',
};

// 准备的第一步：底子 variant 的 src 由 copySource 复制到 src/。重试时先删去上次复制了一半的 src/
export function copyDraftSource(layout: DraftLayout, copySource: (dest: string) => void) {
  fs.mkdirSync(layout.dir, { recursive: true });
  fs.rmSync(layout.src, { recursive: true, force: true });
  copySource(layout.src);
}

// 准备的第二步：workflow.yaml、PLATFORM.md 与例子 workflow；重试时整体重写。
// 内置 lfg、ic 之下的 variant 用 wf 构建，说明为 PLATFORM.md；其余由 dashboard 自己管理（Contracts 18.6）
export function writeDraftDocs(
  layout: DraftLayout,
  mode: DraftMode,
  definition: WorkflowDefinition,
) {
  fs.rmSync(layout.workflowYaml, { force: true });
  fs.writeFileSync(layout.workflowYaml, yamlHeader[mode] + stringify(definition));
  if (mode === 'variant') fs.chmodSync(layout.workflowYaml, 0o444);
  const platform = isBuiltinWorkflow(definition.id) ? 'PLATFORM.md' : 'PLATFORM-own.md';
  fs.copyFileSync(path.join(assetsDir, platform), layout.platform);
  fs.rmSync(layout.example, { recursive: true, force: true });
  fs.cpSync(path.join(assetsDir, 'simple-workflow'), layout.example, { recursive: true });
}

// 初始消息（Contracts 17.3）：需求原文，加读什么、写到哪里、用哪些 skill
export function initialMessage(mode: DraftMode, requirement: string): string {
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
    '写 skill 时使用 .agents/skills/writing-for-agents 与 .agents/skills/skill-creator；需要现成的 skill 时用 .agents/skills/find-skills（只用项目范围，装进本目录的 .agents/skills/）。',
  ].join('\n');
}
