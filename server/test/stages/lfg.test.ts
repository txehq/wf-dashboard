import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { featureDir, LfgTracker, lfgSnapshot, slugify } from '../../src/stages/lfg.js';

const VAULT = '/Users/linhaoz/Documents/Obsidian Vault';
const work = path.join(config.repoRoot, '.work', 'stages-lfg');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });

describe('lfg 产物：vault 中真实 feature 目录', () => {
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
    const docs = lfgSnapshot(featureDir(VAULT, product, feature), feature);
    const doc = docs.research ?? docs.design;
    expect(docs.brief !== null).toBe(brief);
    expect(doc !== null).toBe(research);
    const line = docs.research?.planLockLine ?? docs.design?.planLockLine ?? null;
    if (lock === null) expect(line).toBeNull();
    else expect(line?.startsWith(lock)).toBe(true);
    expect(docs.tickets !== null).toBe(tickets);
  });

  test('feature 不符的文件不算', () => {
    const docs = lfgSnapshot(featureDir(VAULT, 'Tokun', 'model-pool'), 'other-run');
    expect(Object.values(docs).every((d) => d === null)).toBe(true);
  });

  test('首次出现就带锁定标记只算 research，改写后才算 plan', () => {
    const src = featureDir(VAULT, 'Tokun', 'github-growth-dashboard');
    const dir = path.join(work, 'live', 'github-growth-dashboard');
    fs.mkdirSync(dir, { recursive: true });
    const tracker = new LfgTracker(dir, 'github-growth-dashboard');
    const present = () =>
      Object.entries(tracker.observe())
        .filter(([, d]) => d !== null)
        .map(([kind]) => kind);

    expect(present()).toEqual([]);
    fs.copyFileSync(path.join(src, 'Brief.md'), path.join(dir, 'Brief.md'));
    expect(present()).toEqual(['brief']);
    fs.copyFileSync(path.join(src, 'Research.md'), path.join(dir, 'Research.md'));
    expect(present()).toEqual(['brief', 'research']);
    expect(present()).toEqual(['brief', 'research']);
    fs.copyFileSync(path.join(src, 'Tickets.md'), path.join(dir, 'Tickets.md'));
    expect(present()).toEqual(['brief', 'research', 'tickets']);
    fs.appendFileSync(path.join(dir, 'Research.md'), '\n- 2026-09-29 plan locked\n');
    expect(tracker.observe().plan?.planLockLine).toMatch(/^Status: locked/);
  });

  test('slugify 与 wf obsidian 一致', () => {
    expect(slugify('Run_01ABC xyz')).toBe('run-01abc-xyz');
    expect(featureDir('/v', 'Magi Eval', 'run-1')).toBe('/v/Project Magi Eval/Features/run-1');
  });
});
