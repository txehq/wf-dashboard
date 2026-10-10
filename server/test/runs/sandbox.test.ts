import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { claudeSandboxProfile } from '../../src/variants/sandbox.js';

// 真实 sandbox-exec：一个 run 能读写自己的目录，读不到其他 run 的 workspace、session 与 vault 目录（Contracts 7.3）
const root = path.join(config.repoRoot, '.work', 'test-sandbox', randomUUID());
const roots = {
  runsDir: path.join(root, 'data', 'runs'),
  variantsDir: path.join(root, 'data', 'variants'),
  featuresDir: path.join(root, 'vault', 'Project Magi Eval', 'Features'),
  home: os.homedir(),
};
const runId = 'r-20261010-mine01';
const otherRun = 'r-20261010-other1';
const variantId = 'variant-mine';
const otherVariant = 'variant-other';
const projects = (v: string) => path.join(roots.variantsDir, v, 'home', 'claude', 'projects');

const files = {
  ownWorkspace: path.join(roots.runsDir, runId, 'workspace', '.research', 'notes.md'),
  otherWorkspace: path.join(roots.runsDir, otherRun, 'workspace', '.research', 'notes.md'),
  ownSkill: path.join(roots.variantsDir, variantId, 'home', 'claude', 'skills', 'lfg', 'SKILL.md'),
  otherVariantSkill: path.join(
    roots.variantsDir,
    otherVariant,
    'home',
    'claude',
    'skills',
    'lfg',
    'SKILL.md',
  ),
  ownSession: path.join(projects(variantId), runId, 'session.jsonl'),
  otherSession: path.join(projects(variantId), otherRun, 'session.jsonl'),
  ownFeature: path.join(roots.featuresDir, runId, 'Brief.md'),
  otherFeature: path.join(roots.featuresDir, otherRun, 'Research.md'),
};
for (const file of Object.values(files)) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `内容 ${path.basename(file)}\n`);
}
const profile = claudeSandboxProfile(runId, variantId, roots);
const probe = `wfd-sandbox-${randomUUID()}`;

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(path.join(os.homedir(), '.cache', probe), { force: true });
});

// 在 sandbox 中运行一条 shell 命令，返回退出码与 stderr
async function sh(command: string) {
  const r = await execa('sandbox-exec', ['-p', profile, '/bin/sh', '-c', command], {
    reject: false,
    stdin: 'ignore',
  });
  return { code: r.exitCode, out: r.stdout, err: r.stderr };
}
const q = (p: string) => `'${p}'`;

describe('claude 进程的 sandbox', () => {
  test('读自己的 workspace、session、skill 与 feature 目录', async () => {
    for (const file of [files.ownWorkspace, files.ownSession, files.ownSkill, files.ownFeature]) {
      const r = await sh(`cat ${q(file)}`);
      expect(r.code, file).toBe(0);
      expect(r.out).toContain(path.basename(file));
    }
    expect((await sh(`ls ${q(path.dirname(files.ownWorkspace))}`)).code).toBe(0);
  });

  test('读不到其他 run 的 workspace、session、vault 目录与其他 variant；也列不出这些目录', async () => {
    for (const file of [
      files.otherWorkspace,
      files.otherSession,
      files.otherFeature,
      files.otherVariantSkill,
    ]) {
      const r = await sh(`cat ${q(file)}`);
      expect(r.code, file).not.toBe(0);
      expect(r.err).toContain('Operation not permitted');
    }
    for (const dir of [roots.runsDir, projects(variantId), roots.featuresDir]) {
      expect((await sh(`ls ${q(dir)}`)).code, dir).not.toBe(0);
    }
    // 路径查找与 stat 照常：能判断目录存在，读不到内容
    expect((await sh(`test -d ${q(path.join(roots.runsDir, otherRun))}`)).code).toBe(0);
  });

  test('写：自己的 run、variant 与 feature 目录可以；其他 run 的 feature 目录、product 根目录与 home 其他位置不行', async () => {
    for (const file of [
      path.join(roots.runsDir, runId, 'workspace', 'new.txt'),
      path.join(roots.variantsDir, variantId, 'tmp', 'new.txt'),
      path.join(roots.featuresDir, runId, 'Tickets.md'),
      path.join(os.homedir(), '.cache', probe),
    ]) {
      expect(
        (await sh(`mkdir -p ${q(path.dirname(file))} && echo x > ${q(file)}`)).code,
        file,
      ).toBe(0);
    }
    for (const file of [
      path.join(roots.featuresDir, otherRun, 'Brief.md'),
      path.join(roots.featuresDir, '..', 'index.md'),
      path.join(os.homedir(), probe),
    ]) {
      const r = await sh(`echo x > ${q(file)}`);
      expect(r.code, file).not.toBe(0);
      expect(r.err).toContain('Operation not permitted');
    }
    expect(fs.existsSync(path.join(os.homedir(), probe))).toBe(false);
  });

  test('ctx 与 ~/.mcp-auth 照常可用', async () => {
    const ctx = await sh(`${q(config.ctxBin)} --version`);
    expect(ctx.code, ctx.err).toBe(0);
    expect((await sh(`ls ${q(path.join(os.homedir(), '.mcp-auth'))}`)).code).toBe(0);
  });
});
