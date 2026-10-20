import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import type { WorkflowDefinition } from '../workflows/schema.js';
import { HttpError } from './errors.js';

// skill 目录的名字即 skill 名，也是 workflow 的入口或小阶段 id
const SKILL_NAME = /^[a-z][a-z0-9-]*$/;

// skills/<name>/ 的绝对路径；名字不合规定时 400，不会落到 skills/ 以外
export function skillDir(skillsDir: string, name: string): string {
  if (!SKILL_NAME.test(name)) {
    throw new HttpError(400, `skill 名只能包含小写字母、数字与连字符，以字母开头：${name}`);
  }
  const dir = path.join(skillsDir, name);
  if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new HttpError(400, `skill 目录是符号链接：${name}`);
  }
  return dir;
}

// 把 SKILL.md frontmatter 的 name 改为 name：只改这一个键（yaml Document 保留注释与格式），正文不变。
// 没有 frontmatter 时原样返回
export function renameFrontmatter(text: string, name: string): string {
  // gray-matter 只用来切出 frontmatter 的原文；传入选项时不用它的缓存（缓存命中的结果没有 matter 原文）
  const raw = matter(text, { language: 'yaml' }).matter;
  if (raw.trim() === '') return text;
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new HttpError(
      400,
      `SKILL.md 的 frontmatter 不是合法的 YAML：${doc.errors.map((e) => e.message).join('；')}`,
    );
  }
  doc.set('name', name);
  const at = text.indexOf(raw);
  return `${text.slice(0, at)}\n${doc.toString().trimEnd()}${text.slice(at + raw.length)}`;
}

const Frontmatter = z.looseObject({
  name: z.string().min(1),
  description: z.string().trim().min(1),
});

// 一个 SKILL.md 的 frontmatter 有什么问题（Contracts 17.4、18.6）：是 YAML 映射，有 name 与 description，
// name 与目录名相同。没有问题时为 null，有问题时是给用户看的原文
export function frontmatterProblem(file: string, dirName: string): string | null {
  const text = fs.readFileSync(file, 'utf8');
  // gray-matter 只用来切出 frontmatter 的原文（它自带的 YAML 解析遇到错误直接抛出，没有位置信息），
  // 解析与报错由 yaml 库的 Document 做；传入选项时 gray-matter 不用缓存
  const raw = matter(text, { language: 'yaml', engines: { yaml: () => ({}) } }).matter;
  if (!text.startsWith('---') || raw.trim() === '') {
    return `${file} 没有 YAML frontmatter（应以 --- 开头）`;
  }
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    return `${file} 的 frontmatter 不是合法的 YAML：${doc.errors.map((e) => e.message).join('；')}`;
  }
  const parsed = Frontmatter.safeParse(doc.toJS());
  if (!parsed.success) return `${file} 的 frontmatter 不合法：${parsed.error.message}`;
  if (parsed.data.name !== dirName) {
    return `${file} 的 frontmatter name 为 ${parsed.data.name}，应与目录名 ${dirName} 相同`;
  }
  return null;
}

// skills/ 中每个 skill 目录都有 SKILL.md 且 frontmatter 没有问题；返回第一个问题的原文，都没有时为 null
export function skillsProblem(skillsDir: string): string | null {
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) return `skill 目录 skills/${entry.name}/ 中没有 SKILL.md`;
    const problem = frontmatterProblem(file, entry.name);
    if (problem !== null) return problem;
  }
  return null;
}

// 空白新建的骨架（Contracts 18.5）：入口与每个小阶段各一个 SKILL.md，只有 frontmatter（name 与一句 description）
// 与一行"在这里写这个阶段做什么"
export function writeSkeleton(skillsDir: string, definition: WorkflowDefinition) {
  const skills = [
    {
      name: definition.id,
      description: `${definition.name} 的入口 /${definition.id}：依次进入 ${definition.stages.map((s) => s.id).join('、')}`,
    },
    ...definition.stages.map((s) => ({
      name: s.id,
      description: `${definition.name} 的小阶段 ${s.id}`,
    })),
  ];
  for (const skill of skills) {
    const dir = skillDir(skillsDir, skill.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\n${stringify(skill).trimEnd()}\n---\n\n在这里写这个阶段做什么。\n`,
    );
  }
}

// srcDir 下 skills/ 的全部文件，返回以 skills/ 开头、按字典序排列的相对路径
export function listSkillFiles(srcDir: string): string[] {
  const skillsDir = path.join(srcDir, 'skills');
  return fs
    .readdirSync(skillsDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      path.relative(srcDir, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'),
    )
    .sort();
}

// skills/ 树的 hash：按相对路径排序，逐个文件 "<path>\0<sha256>\n" 再 sha256；path 相对 skills/
export function skillsHash(srcDir: string): string {
  const hash = createHash('sha256');
  for (const file of listSkillFiles(srcDir)) {
    const content = fs.readFileSync(path.join(srcDir, file));
    const relative = file.slice('skills/'.length);
    hash.update(`${relative}\0${createHash('sha256').update(content).digest('hex')}\n`);
  }
  // src/mcp.json 也是 variant 的内容（Contracts 28.1）；没有这个文件时 hash 与之前相同
  const mcp = path.join(srcDir, 'mcp.json');
  if (fs.existsSync(mcp)) {
    hash.update(
      `../mcp.json\0${createHash('sha256').update(fs.readFileSync(mcp)).digest('hex')}\n`,
    );
  }
  return hash.digest('hex');
}

// 把 API 传入的路径解析为 srcDir 下的绝对路径；只接受 skills/ 以内、不含 . 或 .. 段的相对路径
export function resolveSkillPath(srcDir: string, relativePath: string): string {
  const segments = relativePath.split('/');
  if (
    relativePath.includes('\\') ||
    relativePath.includes('\0') ||
    segments[0] !== 'skills' ||
    segments.length < 3 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new HttpError(400, `只允许访问 skills/<skill>/ 以内的文件：${relativePath}`);
  }
  const skillsDir = path.join(srcDir, 'skills');
  const absolute = path.join(srcDir, ...segments);
  // 逐级检查已存在的上级目录不是符号链接，防止经链接写到 skills/ 以外
  let current = skillsDir;
  for (const segment of segments.slice(1)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) break;
    if (stat.isSymbolicLink()) throw new HttpError(400, `路径经过符号链接：${relativePath}`);
  }
  return absolute;
}
