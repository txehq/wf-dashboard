import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { parseDocument } from 'yaml';
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
    throw new HttpError(400, `只允许编辑 skills/<skill>/ 以内的文件：${relativePath}`);
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
