import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { execa } from 'execa';
import { afterAll, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { deriveFromSession, rebindAll } from '../src/bindings/index.js';
import { config } from '../src/config.js';
import { openDatabase } from '../src/db/index.js';
import { sessions } from '../src/db/schema.js';
import { ingestFile } from '../src/ingest/ingest.js';
import { createVariants, type Variant } from '../src/variants/index.js';
import { wfSandboxProfile } from '../src/variants/sandbox.js';
import { BASE_COMMIT, modifiedIcSession, workDir } from './helpers/session-fixtures.js';

// Contracts 15.1：按 session 的 skill 新建的 variant 可以真实构建与隔离安装。
// 与 variants.test 共用 .work/test-data 中的 runtime 与 cargo target 缓存
const dataDir = path.join(config.repoRoot, '.work', 'test-data');
const dir = workDir('bindings-build');
const db = openDatabase(path.join(dir, 'db.sqlite'), config.migrationsDir);
const variants = createVariants({
  db,
  dataDir,
  repo: config.txeWorkflowRepo,
  ctxBin: config.ctxBin,
  onSkillsChanged: () => {
    rebindAll(db, dataDir);
  },
});
const created: Variant[] = [];

afterAll(() => {
  for (const v of created) fs.rmSync(variants.layout(v.id).dir, { recursive: true, force: true });
  db.$client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('按 session 的 skill 新建 variant 并构建', () => {
  test(
    '构建成功、wf status 0 退出、安装的 claim 与 session 中的正文一致，并自动绑定该 session',
    { timeout: 1_800_000 },
    async () => {
      const base = await variants.createBaseline({
        name: `w31-build-base-${randomUUID().slice(0, 8)}`,
        commit: BASE_COMMIT,
      });
      created.push(base);
      const modified = modifiedIcSession(dir, 'read everything it points at', 'read all of it');
      ingestFile(db, modified.file);
      const derived = deriveFromSession(db, variants, dataDir, modified.sessionId, {
        baseVariantId: base.id,
        name: `w31-build-${randomUUID().slice(0, 8)}`,
      });
      created.push(derived);
      expect(
        db
          .select({ variantId: sessions.variantId, binding: sessions.variantBinding })
          .from(sessions)
          .where(eq(sessions.id, modified.sessionId))
          .get(),
      ).toEqual({ variantId: derived.id, binding: 'auto' });

      const built = await variants.build(derived.id);
      expect(built.buildStatus).toBe('built');
      const dirs = variants.layout(derived.id);
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
      const installed = fs.readFileSync(path.join(dirs.claudeDir, 'skills/claim/SKILL.md'), 'utf8');
      expect(installed).toBe(variants.readFile(derived.id, 'skills/claim/SKILL.md'));
      expect(installed).toContain('read all of it');
      // 构建不改变绑定
      rebindAll(db, dataDir);
      expect(
        db
          .select({ variantId: sessions.variantId })
          .from(sessions)
          .where(eq(sessions.id, modified.sessionId))
          .get()?.variantId,
      ).toBe(derived.id);
    },
  );
});
