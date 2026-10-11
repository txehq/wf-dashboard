import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { execa } from 'execa';
import { afterAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { importRun } from '../scripts/import-run-lib.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { variants as variantsTable } from '../src/db/schema.js';
import { syncTasks } from '../src/tasks/loader.js';
import { createVariants, type Variant } from '../src/variants/index.js';
import { dataLayout } from '../src/variants/layout.js';
import { wfSandboxProfile } from '../src/variants/sandbox.js';
import { listSkillFiles } from '../src/variants/skills.js';

// W26：导入的 variant 派生为可运行的 variant。真实数据：W4 端到端留在 wfd-w4 中的已评分 lfg run，
// 导入到与 variants.test 共用的数据目录（runtime 与 cargo target 缓存在那里），真实构建
const w4Data = '/Users/linhaoz/orca/workspaces/wf-dashboard/wfd-w4/data';
const runId = 'r-20261009-dqva52';
const importedId = '75c3c7a4-a479-45f2-83f7-bd2da8f7d6d9';

const dataDir = path.join(config.repoRoot, '.work', 'test-data');
const dbFile = path.join(config.repoRoot, '.work', 'test-db', `${randomUUID()}.sqlite`);
const db = openDatabase(dbFile, config.migrationsDir);
syncTasks(db, config.tasksDir);
const variants = createVariants({
  db,
  dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
});
const layout = dataLayout(dataDir);
let derived: Variant | undefined;

afterAll(() => {
  db.$client.close();
  for (const suffix of ['', '-wal', '-shm']) fs.rmSync(dbFile + suffix, { force: true });
  // 导入的 variant 与派生的 variant 的目录只属于这次测试；基线导出与 runtime 留作缓存
  fs.rmSync(layout.variant(importedId).dir, { recursive: true, force: true });
  if (derived !== undefined) {
    fs.rmSync(layout.variant(derived.id).dir, { recursive: true, force: true });
  }
});

const files = (dir: string) =>
  listSkillFiles(dir).map((file) => [file, fs.readFileSync(path.join(dir, file), 'utf8')]);

describe('导入的 variant 派生为可运行的 variant', () => {
  test(
    '派生、构建，wf status 0 退出，skills 与导入的一致；导入的 variant 本身不能构建与编辑',
    { timeout: 900_000 },
    async () => {
      fs.rmSync(layout.variant(importedId).dir, { recursive: true, force: true });
      importRun(db, { dataDir: w4Data }, runId, dataDir);
      const imported = variants.get(importedId);
      expect(imported.installDir).toBeNull();

      await expect(variants.build(importedId)).rejects.toThrow(/导入的/);
      expect(() => variants.writeFile(importedId, 'skills/lfg/SKILL.md', 'x')).toThrow(/导入的/);
      expect(() => variants.setSettings(importedId, { effort: 'low' })).toThrow(/导入的/);

      derived = variants.derive(importedId, { name: `w26-${randomUUID().slice(0, 8)}` });
      expect(derived).toMatchObject({
        parentId: importedId,
        baseCommit: imported.baseCommit,
        model: imported.model,
        effort: imported.effort,
        status: 'draft',
        skillsHash: imported.skillsHash,
        buildStatus: 'none',
      });
      expect(derived.installDir).not.toBeNull();
      const dirs = variants.layout(derived.id);
      // skills 来自导入的 variant，其余来自基线导出
      expect(files(dirs.src)).toEqual(files(layout.variant(importedId).src));
      expect(fs.readFileSync(path.join(dirs.src, 'Cargo.toml'), 'utf8')).toBe(
        fs.readFileSync(path.join(layout.base(imported.baseCommit), 'Cargo.toml'), 'utf8'),
      );
      expect(variants.diff(derived.id, 'parent').files).toEqual([]);

      const built = await variants.build(derived.id);
      expect(built.buildStatus).toBe('built');
      expect(built.builtHash).toBe(imported.skillsHash);
      const status = await execa(
        'sandbox-exec',
        ['-p', wfSandboxProfile(dirs.dir), dirs.wfBin, 'status'],
        {
          env: {
            PATH: z.string().parse(process.env.PATH),
            HOME: os.homedir(),
            WF_HOME: dirs.wfHome,
            CLAUDE_CONFIG_DIR: dirs.claudeDir,
            CODEX_HOME: dirs.codexHome,
            TMPDIR: dirs.tmp,
          },
          extendEnv: false,
        },
      );
      expect(status.exitCode).toBe(0);
      expect(status.stdout).toContain(built.version);
      // 隔离安装的 skills 与导入的 variant 逐字节相同
      const installed = path.join(dirs.claudeDir, 'skills');
      for (const [file, content] of files(layout.variant(importedId).src)) {
        if (file === undefined || content === undefined) throw new Error('文件列表为空');
        expect(
          fs.readFileSync(path.join(installed, file.slice('skills/'.length)), 'utf8'),
          file,
        ).toBe(content);
      }
      // 派生的 variant 可以编辑
      const edited = variants.writeFile(derived.id, 'skills/lfg/NOTE.md', 'W26\n');
      expect(edited.skillsHash).not.toBe(imported.skillsHash);
    },
  );

  test('基线导出缺失时派生以原文失败', () => {
    const commit = '0'.repeat(40);
    db.update(variantsTable)
      .set({ baseCommit: commit })
      .where(eq(variantsTable.id, importedId))
      .run();
    expect(() =>
      variants.derive(importedId, { name: `w26-missing-${randomUUID().slice(0, 8)}` }),
    ).toThrow(`基线 ${commit} 的导出不存在`);
  });
});
