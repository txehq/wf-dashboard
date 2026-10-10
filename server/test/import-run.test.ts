import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { syncTasks } from '../src/tasks/loader.js';
import { createVariants } from '../src/variants/index.js';
import { dataLayout } from '../src/variants/layout.js';
import { importRun, repairImportedVariants } from '../scripts/import-run-lib.js';

// 真实数据：W4 端到端留在 wfd-w4 worktree 中的已评分 lfg run；导入到一个新的数据目录
const w4Data = '/Users/linhaoz/orca/workspaces/wf-dashboard/wfd-w4/data';
const runId = 'r-20261009-dqva52';
const variantId = '75c3c7a4-a479-45f2-83f7-bd2da8f7d6d9';
const commit = '9f2bed6fbdcef9e30a9a773a95bc5a9d618016ff';

const dataDir = path.join(config.repoRoot, '.work', 'test-import-run', randomUUID());
fs.mkdirSync(dataDir, { recursive: true });
const dbPath = path.join(dataDir, 'db.sqlite');
const db = openDatabase(dbPath, config.migrationsDir);
// run 行引用 tasks 表
syncTasks(db, config.tasksDir);
const variants = createVariants({
  db,
  dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});
const layout = dataLayout(dataDir);

afterAll(() => {
  db.$client.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('导入 run 时带上 variant 的内容', () => {
  test(
    '导入后 files 与 diff 可用，只复制 skills、variant.json 与基线导出',
    { timeout: 300_000 },
    async () => {
      // lfg 的阶段按产物判定，不调用模型
      await importRun(db, { dataDir: w4Data }, runId, 'claude-sonnet-5', dataDir);

      const row = variants.get(variantId);
      expect(row.installDir).toBeNull();
      expect(row.buildStatus).toBe('none');

      const files = variants.listFiles(variantId);
      expect(files.length).toBeGreaterThan(50);
      expect(files.map((f) => f.path)).toContain('skills/lfg/SKILL.md');
      expect(variants.readFile(variantId, 'skills/lfg/SKILL.md')).toContain('name: lfg');
      const diff = variants.diff(variantId, 'base');
      expect(diff.against).toEqual({ kind: 'base', variantId: null, commit });
      expect(Array.isArray(diff.files)).toBe(true);

      const dir = layout.variant(variantId);
      expect(fs.readdirSync(dir.dir).sort()).toEqual(['src', 'variant.json']);
      expect(fs.readdirSync(dir.src)).toEqual(['skills']);
      expect(fs.readFileSync(dir.manifest, 'utf8')).toBe(
        fs.readFileSync(dataLayout(w4Data).variant(variantId).manifest, 'utf8'),
      );
      expect(fs.existsSync(path.join(layout.base(commit), 'Cargo.toml'))).toBe(true);
    },
  );

  test('早先导入没有内容的 variant：repair 从来源补齐，已有的不再复制', () => {
    fs.rmSync(layout.variant(variantId).dir, { recursive: true });
    expect(() => variants.listFiles(variantId)).toThrow(/ENOENT/);

    const sources = [path.join(dataDir, 'no-such-source'), w4Data];
    const repaired = repairImportedVariants(dbPath, dataDir, sources);
    expect(repaired).toEqual([
      {
        variantId,
        from: w4Data,
        copied: [layout.variant(variantId).skills, layout.variant(variantId).manifest],
      },
    ]);
    expect(variants.listFiles(variantId).length).toBeGreaterThan(50);

    expect(repairImportedVariants(dbPath, dataDir, sources)[0]?.copied).toEqual([]);
  });

  test('来源中都没有该 variant 时直接抛错', () => {
    fs.rmSync(layout.variant(variantId).dir, { recursive: true });
    expect(() => repairImportedVariants(dbPath, dataDir, [path.join(dataDir, 'x')])).toThrow(
      `来源数据目录中都没有 variant ${variantId}`,
    );
  });
});
