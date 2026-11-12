import path from 'node:path';
import { sequenceOf } from '../stages/shell.js';

// How Codex loads a skill (Contracts 25.2, measured in Reports/W62, W106):
// - The model uses exec_command to cat the full <dir>/<skill>/SKILL.md. When the command is only simple commands joined by ;, &&, || or newlines
//   (0.163.0 often chains several cats), every SKILL.md argument of every cat is one read; nl, sed, awk reading a part, and
//   commands with pipes or redirects, read or edit the skill and are not loads
// - When user input mentions a skill as $<skill>, 0.163.0 injects its full text as a <skill> message (injectedSkill)

export interface SkillRead {
  name: string;
  // The path as written in the command (may be relative to cwd)
  path: string;
}

function skillOfPath(file: string): SkillRead | null {
  if (path.basename(file) !== 'SKILL.md') return null;
  const name = path.basename(path.dirname(file));
  return name === '' || name === '.' ? null : { name, path: file };
}

// All skills one command reads, in order of appearance
export function catSkills(cmd: string): SkillRead[] {
  return (sequenceOf(cmd) ?? []).flatMap((argv) =>
    argv[0] === 'cat' && argv.slice(1).every((a) => !a.startsWith('-'))
      ? argv.slice(1).flatMap((a) => skillOfPath(a) ?? [])
      : [],
  );
}

// The skill read when the command is a single cat of one SKILL.md, so the output is the full SKILL.md; otherwise null
export function catSkill(cmd: string): SkillRead | null {
  const commands = sequenceOf(cmd);
  const [argv] = commands ?? [];
  if (commands?.length !== 1 || argv?.length !== 2 || argv[0] !== 'cat') return null;
  return skillOfPath(argv[1] ?? '');
}

// Skills loaded by one tool call in a request: SKILL.md files read by cat in the cmd of exec_command (called by the model directly, or run from an exec script),
// when the call did not fail
export function codexSkillsOfCall(call: {
  name: string;
  input: unknown;
  isError?: boolean;
}): string[] {
  if (call.name !== 'exec_command' || call.isError === true) return [];
  if (typeof call.input !== 'object' || call.input === null) return [];
  const cmd = (call.input as Record<string, unknown>).cmd;
  return typeof cmd === 'string' ? catSkills(cmd).map((s) => s.name) : [];
}

// Resolve a path in the command against the command's working directory
export function resolveSkillPath(skillPath: string, cwd: string): string {
  return path.isAbsolute(skillPath) ? skillPath : path.join(cwd, skillPath);
}

// Raw <skill> injection: <skill>\n<name>name</name>\n<path>absolute SKILL.md path</path>\nfull SKILL.md\n</skill>
const INJECTED =
  /^<skill>\n<name>([^<\n]+)<\/name>\n<path>([^<\n]+)<\/path>\n([\s\S]*)\n<\/skill>$/;

// Whether a text in a role user message is a <skill> injection: if so, returns the skill name, SKILL.md path and full text
export function injectedSkill(text: string): { name: string; path: string; body: string } | null {
  const m = INJECTED.exec(text);
  if (m === null) return null;
  const [, name = '', file = '', body = ''] = m;
  return { name, path: file, body };
}
