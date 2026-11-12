import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { orcaFreeEnv } from './cli.js';

// A variant carries Orca's skills (Contracts 35.5): orca skills get gives orchestration and orca-cli matching this Orca version,
// written into the variant's skills/ at build time with the Orca version recorded; a new Orca version needs a rebuild
export const ORCA_SKILLS = ['orchestration', 'orca-cli'] as const;

// The local Orca version; null without an orca command
export async function orcaVersion(bin: string): Promise<string | null> {
  const result = await execa(bin, ['--version'], {
    env: orcaFreeEnv(process.env),
    extendEnv: false,
    reject: false,
    input: '',
  });
  if (result.failed && result.exitCode === undefined) return null;
  if (result.exitCode !== 0) {
    throw new Error(`${bin} --version exited with ${String(result.exitCode)}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

// Written to <skillsDir>/<name>/SKILL.md; returns the Orca version used
export async function writeOrcaSkills(bin: string, skillsDir: string): Promise<string> {
  const version = await orcaVersion(bin);
  if (version === null)
    throw new Error(`No orca command on this machine (${bin}), cannot include Orca's skills`);
  for (const name of ORCA_SKILLS) {
    const guide = await execa(bin, ['skills', 'get', name], {
      env: orcaFreeEnv(process.env),
      extendEnv: false,
      input: '',
    });
    if (!guide.stdout.startsWith('---\n')) {
      throw new Error(
        `orca skills get ${name} output is not a SKILL.md with frontmatter: ${guide.stdout.slice(0, 200)}`,
      );
    }
    const dir = path.join(skillsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'SKILL.md'), `${guide.stdout.trimEnd()}\n`);
  }
  return version;
}
