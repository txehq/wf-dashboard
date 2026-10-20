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

// vault 中真实 feature 目录的副本（只有 rubric 产物的候选文件）
const VAULT = fileURLToPath(new URL('../fixtures/vault/', import.meta.url));
const work = path.join(config.repoRoot, '.work', 'stages-artifacts');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

// lfg 评测类型的 rubric 产物：brief、research、plan、tickets
const specs = rubricOf(EVAL_KINDS.lfg) ?? [];
function spec(id: string): RubricArtifactSpec {
  const found = specs.find((s) => s.id === id);
  if (found === undefined) throw new Error(`lfg 评测类型没有产物 ${id}`);
  return found;
}

describe('rubric 产物：vault 中真实 feature 目录', () => {
  // 三个计算器 run 写到 Project Magi Eval 的产物：dqva52 走完四个阶段（Research.md 中 plan 已锁定），
  // i6vxt1 停在 research，a9piql 停在 interview
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
    // Research.md 优先，其次 System Design.md
    const docs = candidateDocs(dir, feature, spec('research'));
    const line = docs[0]?.planLockLine ?? docs[1]?.planLockLine ?? null;
    if (lock === null) expect(line).toBeNull();
    else expect(line?.startsWith(lock)).toBe(true);
    expect(present('tickets')).toBe(tickets);
  });

  test('feature 不符的文件不算', () => {
    const dir = featureDir(VAULT, 'Magi Eval', 'r-20261009-dqva52');
    expect(specs.flatMap((s) => candidateDocs(dir, 'other-run', s)).every((d) => d === null)).toBe(
      true,
    );
  });

  test('中文的 Plan 一节与锁定行', () => {
    const src = featureDir(VAULT, 'Magi Eval', 'r-20261009-i6vxt1');
    const body = fs.readFileSync(path.join(src, 'Research.md'), 'utf8');
    expect(planLockedLine(body)).toBeNull();
    expect(
      planLockedLine(`${body}\n## 计划\n\n状态： locked · 2026-09-18 · 来源： §6 规格\n`),
    ).toBe('状态： locked · 2026-09-18 · 来源： §6 规格');
  });

  test('首次出现就带锁定标记只算 research，改写后才算 plan', () => {
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

  test('slugify 与 wf obsidian 一致', () => {
    expect(slugify('Run_01ABC xyz')).toBe('run-01abc-xyz');
    expect(featureDir('/v', 'Magi Eval', 'run-1')).toBe('/v/Project Magi Eval/Features/run-1');
  });
});
