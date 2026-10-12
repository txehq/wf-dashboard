import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { ArtifactTracker, candidateDocs, featureDir, slugify } from '../../src/stages/artifacts.js';
import { builtinDefinition } from '../../src/workflows/index.js';
import { bigStageOf, rubricOf, type RubricArtifactSpec } from '../../src/workflows/schema.js';

const VAULT = '/Users/linhaoz/Documents/Obsidian Vault';
const work = path.join(config.repoRoot, '.work', 'stages-artifacts');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

// dev-workflow 的 lfg 的 rubric 产物：brief、research、plan、tickets
const specs = rubricOf(bigStageOf(builtinDefinition(), 'lfg')) ?? [];
function spec(id: string): RubricArtifactSpec {
  const found = specs.find((s) => s.id === id);
  if (found === undefined) throw new Error(`dev-workflow 的 lfg 没有产物 ${id}`);
  return found;
}

describe('rubric 产物：vault 中真实 feature 目录', () => {
  // Stage Markers 1.4 的结果（.spikes/stage-markers/out/lfg-rules-vault.txt）
  const expected: [string, string, [boolean, boolean, string | null, boolean]][] = [
    ['Magi', 'optional-mcp-install', [true, true, null, true]],
    ['Magi', 'release-train-service', [false, true, null, false]],
    ['Magi', 'txe-workflow', [true, false, null, false]],
    ['Magi', 'ui-copy-guidelines', [false, true, null, false]],
    [
      'Tokun',
      'github-growth-dashboard',
      [true, true, 'Status: locked · 2026-09-29 · From: Research.md §6', true],
    ],
    ['Tokun', 'model-pool', [true, true, '状态： locked · 2026-09-18 · 来源： §6 规格', true]],
    ['Tokun', 'sub2api-ci-bazel-migration', [false, true, null, true]],
    ['Tokun', 'sub2api-ci-release-performance', [false, true, null, false]],
  ];

  test.each(expected)('Project %s/%s', (product, feature, [brief, research, lock, tickets]) => {
    const dir = featureDir(VAULT, product, feature);
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
    const dir = featureDir(VAULT, 'Tokun', 'model-pool');
    expect(specs.flatMap((s) => candidateDocs(dir, 'other-run', s)).every((d) => d === null)).toBe(
      true,
    );
  });

  test('首次出现就带锁定标记只算 research，改写后才算 plan', () => {
    const src = featureDir(VAULT, 'Tokun', 'github-growth-dashboard');
    const dir = path.join(work, 'live', 'github-growth-dashboard');
    fs.mkdirSync(dir, { recursive: true });
    const tracker = new ArtifactTracker(dir, 'github-growth-dashboard', specs);
    const present = () => [...tracker.observe()].filter(([, d]) => d !== null).map(([id]) => id);

    expect(present()).toEqual([]);
    fs.copyFileSync(path.join(src, 'Brief.md'), path.join(dir, 'Brief.md'));
    expect(present()).toEqual(['brief']);
    fs.copyFileSync(path.join(src, 'Research.md'), path.join(dir, 'Research.md'));
    expect(present()).toEqual(['brief', 'research']);
    expect(present()).toEqual(['brief', 'research']);
    fs.copyFileSync(path.join(src, 'Tickets.md'), path.join(dir, 'Tickets.md'));
    expect(present()).toEqual(['brief', 'research', 'tickets']);
    fs.appendFileSync(path.join(dir, 'Research.md'), '\n- 2026-09-29 plan locked\n');
    expect(tracker.observe().get('plan')?.planLockLine).toMatch(/^Status: locked/);
  });

  test('slugify 与 wf obsidian 一致', () => {
    expect(slugify('Run_01ABC xyz')).toBe('run-01abc-xyz');
    expect(featureDir('/v', 'Magi Eval', 'run-1')).toBe('/v/Project Magi Eval/Features/run-1');
  });
});
