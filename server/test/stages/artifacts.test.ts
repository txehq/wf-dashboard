import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import {
  ArtifactTracker,
  candidateDocs,
  featureDir,
  planLockedLine,
  slugify,
} from '../../src/stages/artifacts.js';
import { EVAL_KINDS } from '../../src/workflows/eval-kinds.js';
import { rubricOf, type RubricArtifactSpec } from '../../src/workflows/schema.js';

// Copies of real feature directories from the vault (only the candidate files of rubric artifacts)
const VAULT = fileURLToPath(new URL('../fixtures/vault/', import.meta.url));
const work = path.join(config.repoRoot, '.work', 'stages-artifacts');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

// Rubric artifacts of the lfg eval kind: brief, research, plan, tickets
const specs = rubricOf(EVAL_KINDS.lfg) ?? [];
function spec(id: string): RubricArtifactSpec {
  const found = specs.find((s) => s.id === id);
  if (found === undefined) throw new Error(`The lfg eval kind has no artifact ${id}`);
  return found;
}

describe('rubric artifacts: real feature directories in the vault', () => {
  // Artifacts three calculator runs wrote to Project Magi Eval: dqva52 went through all four stages (plan locked in
  // Research.md), i6vxt1 stopped at research, a9piql stopped at interview
  const expected: [string, [boolean, boolean, string | null, boolean]][] = [
    ['r-20261009-dqva52', [true, true, 'Status: locked · 2026-10-10 · From: Research.md §7', true]],
    ['r-20261009-i6vxt1', [true, true, null, false]],
    ['r-20261009-a9piql', [true, false, null, false]],
  ];

  test.each(expected)('Project Magi Eval/%s', (feature, [brief, research, lock, tickets]) => {
    const dir = featureDir(VAULT, 'Magi Eval', feature);
    const present = (id: string) => candidateDocs(dir, feature, spec(id)).some((d) => d !== null);
    expect(present('brief')).toBe(brief);
    expect(present('research')).toBe(research);
    // Research.md first, then System Design.md
    const docs = candidateDocs(dir, feature, spec('research'));
    const line = docs[0]?.planLockLine ?? docs[1]?.planLockLine ?? null;
    if (lock === null) expect(line).toBeNull();
    else expect(line?.startsWith(lock)).toBe(true);
    expect(present('tickets')).toBe(tickets);
  });

  test('files with another feature do not count', () => {
    const dir = featureDir(VAULT, 'Magi Eval', 'r-20261009-dqva52');
    expect(specs.flatMap((s) => candidateDocs(dir, 'other-run', s)).every((d) => d === null)).toBe(
      true,
    );
  });

  test('a Plan section and lock line written in Chinese', () => {
    const src = featureDir(VAULT, 'Magi Eval', 'r-20261009-i6vxt1');
    const body = fs.readFileSync(path.join(src, 'Research.md'), 'utf8');
    expect(planLockedLine(body)).toBeNull();
    // The escapes are the Chinese "plan" heading, "status" and a full-width colon
    expect(
      planLockedLine(
        `${body}\n## \u{8BA1}\u{5212}\n\n\u{72B6}\u{6001}\u{FF1A} locked · 2026-09-18\n`,
      ),
    ).toBe('\u{72B6}\u{6001}\u{FF1A} locked · 2026-09-18');
  });

  test('a lock marker present on first appearance counts only as research; plan needs a rewrite', () => {
    const feature = 'r-20261009-dqva52';
    const src = featureDir(VAULT, 'Magi Eval', feature);
    const dir = path.join(work, 'live', feature);
    fs.mkdirSync(dir, { recursive: true });
    const tracker = new ArtifactTracker(dir, feature, specs);
    const present = () => [...tracker.observe()].filter(([, d]) => d !== null).map(([id]) => id);

    expect(present()).toEqual([]);
    fs.copyFileSync(path.join(src, 'Brief.md'), path.join(dir, 'Brief.md'));
    expect(present()).toEqual(['brief']);
    fs.copyFileSync(path.join(src, 'Research.md'), path.join(dir, 'Research.md'));
    expect(present()).toEqual(['brief', 'research']);
    expect(present()).toEqual(['brief', 'research']);
    fs.copyFileSync(path.join(src, 'Tickets.md'), path.join(dir, 'Tickets.md'));
    expect(present()).toEqual(['brief', 'research', 'tickets']);
    fs.appendFileSync(path.join(dir, 'Research.md'), '\n- 2026-10-10 plan locked\n');
    expect(tracker.observe().get('plan')?.planLockLine).toMatch(/^Status: locked/);
  });

  test('slugify matches wf obsidian', () => {
    expect(slugify('Run_01ABC xyz')).toBe('run-01abc-xyz');
    expect(featureDir('/v', 'Magi Eval', 'run-1')).toBe('/v/Project Magi Eval/Features/run-1');
  });
});
