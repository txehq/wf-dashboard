import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { parseDocument } from 'yaml';
import { z } from 'zod';
import { HttpError } from '../variants/errors.js';
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

const Frontmatter = z.looseObject({
  name: z.string().min(1),
  description: z.string().trim().min(1),
});

// 一个 SKILL.md 的 frontmatter：YAML 映射，name 与目录名相同，description 不为空
function checkFrontmatter(file: string, dirName: string) {
  const text = fs.readFileSync(file, 'utf8');
  // gray-matter 只用来切出 frontmatter 的原文（它自带的 YAML 解析遇到错误直接抛出，没有位置信息），
  // 解析与报错由 yaml 库的 Document 做；传入选项时 gray-matter 不用缓存
  const raw = matter(text, { language: 'yaml', engines: { yaml: () => ({}) } }).matter;
  if (!text.startsWith('---') || raw.trim() === '') {
    throw new HttpError(400, `${file} 没有 YAML frontmatter（应以 --- 开头）`);
  }
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new HttpError(
      400,
      `${file} 的 frontmatter 不是合法的 YAML：${doc.errors.map((e) => e.message).join('；')}`,
    );
  }
  const parsed = Frontmatter.safeParse(doc.toJS());
  if (!parsed.success) {
    throw new HttpError(400, `${file} 的 frontmatter 不合法：${parsed.error.message}`);
  }
  if (parsed.data.name !== dirName) {
    throw new HttpError(
      400,
      `${file} 的 frontmatter name 为 ${parsed.data.name}，应与目录名 ${dirName} 相同`,
    );
  }
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
  for (const entry of fs.readdirSync(layout.skills, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(layout.skills, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) {
      throw new HttpError(400, `skill 目录 src/skills/${entry.name}/ 中没有 SKILL.md`);
    }
    checkFrontmatter(file, entry.name);
  }
}
