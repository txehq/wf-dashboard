import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import type { WorkflowDefinition } from '../workflows/schema.js';
import { HttpError } from './errors.js';

// A skill directory's name is the skill name, and also the workflow's entry or stage id
const SKILL_NAME = /^[a-z][a-z0-9-]*$/;

// Absolute path of skills/<name>/; 400 for an invalid name, so it never resolves outside skills/
export function skillDir(skillsDir: string, name: string): string {
  if (!SKILL_NAME.test(name)) {
    throw new HttpError(
      400,
      `Skill names may contain only lowercase letters, digits and hyphens, starting with a letter: ${name}`,
    );
  }
  const dir = path.join(skillsDir, name);
  if (fs.lstatSync(dir, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new HttpError(400, `Skill directory is a symlink: ${name}`);
  }
  return dir;
}

// Sets the SKILL.md frontmatter name to name: only this key changes (the yaml Document keeps comments and format), the body stays.
// Returned unchanged without frontmatter
export function renameFrontmatter(text: string, name: string): string {
  // gray-matter only cuts out the raw frontmatter; with options it skips its cache (a cache hit has no raw matter)
  const raw = matter(text, { language: 'yaml' }).matter;
  if (raw.trim() === '') return text;
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    throw new HttpError(
      400,
      `SKILL.md frontmatter is not valid YAML: ${doc.errors.map((e) => e.message).join('; ')}`,
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

// What is wrong with a SKILL.md frontmatter (Contracts 17.4, 18.6): it must be a YAML map with name and description,
// and name must equal the directory name. null when fine, otherwise the text shown to the user
export function frontmatterProblem(file: string, dirName: string): string | null {
  const text = fs.readFileSync(file, 'utf8');
  // gray-matter only cuts out the raw frontmatter (its own YAML parser throws on errors without positions);
  // parsing and errors come from the yaml library's Document; with options gray-matter skips its cache
  const raw = matter(text, { language: 'yaml', engines: { yaml: () => ({}) } }).matter;
  if (!text.startsWith('---') || raw.trim() === '') {
    return `${file} has no YAML frontmatter (it must start with ---)`;
  }
  const doc = parseDocument(raw);
  if (doc.errors.length > 0) {
    return `${file} frontmatter is not valid YAML: ${doc.errors.map((e) => e.message).join('; ')}`;
  }
  const parsed = Frontmatter.safeParse(doc.toJS());
  if (!parsed.success) return `${file} frontmatter is invalid: ${parsed.error.message}`;
  if (parsed.data.name !== dirName) {
    return `${file} frontmatter name is ${parsed.data.name}; it must equal the directory name ${dirName}`;
  }
  return null;
}

// Every skill directory in skills/ has a SKILL.md with a valid frontmatter; returns the first problem's text, or null
export function skillsProblem(skillsDir: string): string | null {
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const file = path.join(skillsDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(file)) return `Skill directory skills/${entry.name}/ has no SKILL.md`;
    const problem = frontmatterProblem(file, entry.name);
    if (problem !== null) return problem;
  }
  return null;
}

// Skeleton of a blank new workflow (Contracts 18.5): one SKILL.md for the entry and each stage, with only frontmatter
// (name and a one-line description) and the line "Describe what this stage does here."
export function writeSkeleton(skillsDir: string, definition: WorkflowDefinition) {
  const skills = [
    {
      name: definition.id,
      description: `Entry /${definition.id} of ${definition.name}: runs ${definition.stages.map((s) => s.id).join(', ')} in order`,
    },
    ...definition.stages.map((s) => ({
      name: s.id,
      description: `Stage ${s.id} of ${definition.name}`,
    })),
  ];
  for (const skill of skills) {
    const dir = skillDir(skillsDir, skill.name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'SKILL.md'),
      `---\n${stringify(skill).trimEnd()}\n---\n\nDescribe what this stage does here.\n`,
    );
  }
}

// All files of skills/ under srcDir, as relative paths starting with skills/, sorted lexicographically
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

// Hash of the skills/ tree: files sorted by relative path, each "<path>\0<sha256>\n", then sha256; path relative to skills/
export function skillsHash(srcDir: string): string {
  const hash = createHash('sha256');
  for (const file of listSkillFiles(srcDir)) {
    const content = fs.readFileSync(path.join(srcDir, file));
    const relative = file.slice('skills/'.length);
    hash.update(`${relative}\0${createHash('sha256').update(content).digest('hex')}\n`);
  }
  // src/mcp.json is variant content too (Contracts 28.1); without the file the hash is unchanged
  const mcp = path.join(srcDir, 'mcp.json');
  if (fs.existsSync(mcp)) {
    hash.update(
      `../mcp.json\0${createHash('sha256').update(fs.readFileSync(mcp)).digest('hex')}\n`,
    );
  }
  return hash.digest('hex');
}

// Resolves an API path to an absolute path under srcDir; accepts only relative paths inside skills/ without . or .. segments
export function resolveSkillPath(srcDir: string, relativePath: string): string {
  const segments = relativePath.split('/');
  if (
    relativePath.includes('\\') ||
    relativePath.includes('\0') ||
    segments[0] !== 'skills' ||
    segments.length < 3 ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new HttpError(400, `Only files inside skills/<skill>/ may be accessed: ${relativePath}`);
  }
  const skillsDir = path.join(srcDir, 'skills');
  const absolute = path.join(srcDir, ...segments);
  // Checks each existing parent directory is not a symlink, so nothing is written outside skills/ through a link
  let current = skillsDir;
  for (const segment of segments.slice(1)) {
    current = path.join(current, segment);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (stat === undefined) break;
    if (stat.isSymbolicLink())
      throw new HttpError(400, `Path goes through a symlink: ${relativePath}`);
  }
  return absolute;
}
