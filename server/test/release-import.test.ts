import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { createVariants, type Variant } from '../src/variants/index.js';
import { dataLayout } from '../src/variants/layout.js';
import { createReleaseCheck, releaseVariantName } from '../src/variants/release.js';
import { createWorkflows } from '../src/workflows/index.js';
import { type ReleaseFixture, recordedRelease, releaseRepos } from './helpers/release-fixtures.js';

// Contracts 29.1：lfg、ic 自动导入 txe-workflow 的 release 并真实构建（wf guard、build-local、install、status）。
// 录下的真实 gh 输出先给出 v2.2.2，再给出 Latest v2.3.0；txe-workflow 的两份本地副本建在 .work/ 下，其中两个 tag
// 都指向 txe-workflow 的 v2.3.0 commit（wf 只编译一次）。数据目录与 variants-import.test 共用 .work/test-data，
// 那里缓存着 runtime 与 cargo target；只读取 txe-workflow，不改它
const dataDir = path.join(config.repoRoot, '.work', 'test-data');
const dir = path.join(config.dataDir, `release-import-${randomUUID().slice(0, 8)}`);
const dbFile = path.join(dir, 'db.sqlite');
const db = openDatabase(dbFile, config.migrationsDir);
const layout = dataLayout(dataDir);
const created: string[] = [];

afterAll(() => {
  db.$client.close();
  // variant 的目录只属于这次测试；基线导出与 runtime 留作缓存
  for (const id of created) fs.rmSync(layout.variant(id).dir, { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
});

const git = async (cwd: string, args: string[]) =>
  (await execa('git', ['-C', cwd, ...args])).stdout.trim();

describe('自动导入 txe-workflow 的 release', () => {
  test(
    '各导入一个 variant 并构建；重复检查不重复导入；新 release 另加；同名时记 409 原文；删除后不建回，改名不影响识别',
    { timeout: 900_000 },
    async () => {
      const commit = await git(config.txeWorkflowRepo, ['rev-parse', 'v2.3.0^{commit}']);
      const { work } = await releaseRepos(config.txeWorkflowRepo, dir, [
        { tag: 'v2.2.2', commit },
        { tag: 'v2.3.0', commit },
      ]);
      const variants = createVariants({ db, dataDir, repo: work, ctxBin: config.ctxBin });
      const workflows = createWorkflows({ db, variants });
      const check = (fixture: ReleaseFixture) =>
        createReleaseCheck({
          db,
          variants,
          repo: work,
          readRelease: () => Promise.resolve(recordedRelease(fixture)),
        }).check();
      const all = () => variants.list(true);
      const track = () => {
        for (const v of all()) if (!created.includes(v.id)) created.push(v.id);
      };
      const named = (workflowId: string, name: string): Variant => {
        const found = all().find((v) => v.workflowId === workflowId && v.name === name);
        if (found === undefined) throw new Error(`没有 ${name} (${workflowId})`);
        return found;
      };

      // ic 中已有手动导入的同名 variant
      const manual = await variants.createBaseline({
        name: releaseVariantName('v2.2.2'),
        commit,
        workflowId: 'ic',
      });
      track();
      expect(manual.releaseTag).toBeNull();

      let started = performance.now();
      await check('older');
      track();
      console.log(
        `v2.2.2 的检查（含 wf 编译）${String(Math.round(performance.now() - started))} ms`,
      );
      expect(await git(work, ['tag', '--list'])).toBe('v2.2.2');
      const lfgOld = named('lfg', 'txe-workflow v2.2.2');
      expect(lfgOld).toMatchObject({
        description: 'txe-workflow v2.2.2 release，自动导入',
        releaseTag: 'v2.2.2',
        baseCommit: commit,
        buildStatus: 'built',
      });
      expect(fs.readFileSync(variants.layout(lfgOld.id).buildLog, 'utf8')).toMatch(
        /\[status\] exit 0/,
      );
      expect(workflows.get('lfg').release).toMatchObject({
        tag: 'v2.2.2',
        variantId: lfgOld.id,
        error: null,
      });
      expect(workflows.get('ic').release).toMatchObject({
        tag: 'v2.2.2',
        variantId: null,
        error: '名称已被使用：txe-workflow v2.2.2 (ic)',
      });

      // 再检查一次：没有新的 variant，也不重新构建
      await check('older');
      expect(all()).toHaveLength(2);
      expect(variants.get(lfgOld.id).builtAt).toEqual(lfgOld.builtAt);

      started = performance.now();
      await check('latest');
      track();
      console.log(
        `v2.3.0 的检查（复用 runtime）${String(Math.round(performance.now() - started))} ms`,
      );
      const lfgNew = named('lfg', 'txe-workflow v2.3.0');
      const icNew = named('ic', 'txe-workflow v2.3.0');
      for (const [id, v] of [
        ['lfg', lfgNew],
        ['ic', icNew],
      ] as const) {
        expect(v).toMatchObject({ releaseTag: 'v2.3.0', buildStatus: 'built' });
        expect(workflows.get(id).release).toMatchObject({
          tag: 'v2.3.0',
          publishedAt: Date.parse('2026-10-07T13:25:16Z'),
          variantId: v.id,
          error: null,
        });
      }
      // 旧版保留
      expect(variants.get(lfgOld.id).deletedAt).toBeNull();
      expect(await git(work, ['tag', '--list'])).toBe('v2.2.2\nv2.3.0');

      // 删除 lfg 的、改名 ic 的之后再检查：不建回，改名后照样认得
      variants.markDeleted([lfgNew.id], new Date());
      variants.rename(icNew.id, 'ic 最新版');
      await check('latest');
      expect(all()).toHaveLength(4);
      expect(workflows.get('lfg').release).toMatchObject({ variantId: null, error: null });
      expect(workflows.get('ic').release).toMatchObject({ variantId: icNew.id, error: null });
    },
  );
});
