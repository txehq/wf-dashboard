import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterAll, describe, expect, test } from 'vitest';
import { config } from '../../src/config.js';
import { claudeSandboxProfile } from '../../src/variants/sandbox.js';
import { git } from '../helpers/ic-fixture.js';

// 真实 sandbox-exec：一个 run 能读写自己的目录，读不到其他 run 的 workspace、session 与 vault 目录（Contracts 7.3）
const root = path.join(config.repoRoot, '.work', 'test-sandbox', randomUUID());
const roots = {
  repoRoot: config.repoRoot,
  dataDir: path.join(root, 'data'),
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
  db: path.join(roots.dataDir, 'db.sqlite'),
  // .spikes/ 被 gitignore，worktree 中不一定存在：测试中建一个样本文件，结束时删除
  spike: path.join(config.repoRoot, '.spikes', `test-sandbox-${randomUUID()}.jsonl`),
};
for (const file of Object.values(files)) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `内容 ${path.basename(file)}\n`);
}
const profile = claudeSandboxProfile(runId, variantId, roots);
const probe = `wfd-sandbox-${randomUUID()}`;

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(files.spike, { force: true });
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

  test('读不到 dashboard 仓库与数据目录：隐藏测试、隐藏需求、数据库、源代码、.spikes', async () => {
    for (const file of [
      path.join(config.tasksDir, 'ic-money-format', 'hidden-tests', 'format.hidden.test.js'),
      path.join(config.tasksDir, 'lfg-calculator', 'task.yaml'),
      files.db,
      path.join(config.repoRoot, 'server', 'src', 'grading', 'hidden-tests.ts'),
      files.spike,
    ]) {
      expect(fs.existsSync(file), file).toBe(true);
      const r = await sh(`cat ${q(file)}`);
      expect(r.code, file).not.toBe(0);
      expect(r.err).toContain('Operation not permitted');
    }
    expect((await sh(`ls ${q(config.tasksDir)}`)).code).not.toBe(0);
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

  // 本地仓库模式（Contracts 7.2）：workspace 的 origin 是 .work/ 下的 bare 仓库
  test('本地仓库模式：自己的 bare 仓库可以 fetch 与 push，其他 run 的仓库读不到', async () => {
    const reposDir = path.join(root, 'repos');
    const own = path.join(reposDir, `wfe-${runId}.git`);
    const other = path.join(reposDir, `wfe-${otherRun}.git`);
    const workspace = path.join(roots.runsDir, runId, 'workspace-local');
    for (const bare of [own, other]) {
      await execa('git', ['init', '--quiet', '--bare', '--initial-branch', 'main', bare]);
    }
    await execa('git', ['init', '--quiet', '--initial-branch', 'main', workspace]);
    await git(workspace, ['commit', '--quiet', '--allow-empty', '-m', 'x']);
    const localProfile = claudeSandboxProfile(runId, variantId, roots, own);
    const run = (command: string) =>
      execa('sandbox-exec', ['-p', localProfile, '/bin/sh', '-c', command], {
        reject: false,
        stdin: 'ignore',
        cwd: workspace,
      });
    const push = await run(`git push --quiet ${q(own)} main && git fetch --quiet ${q(own)} main`);
    expect(push.exitCode, push.stderr).toBe(0);
    const denied = await run(`git ls-remote ${q(other)}`);
    expect(denied.exitCode).not.toBe(0);
    expect(denied.stderr).toMatch(/Operation not permitted|not appear to be a git repository/);
    // 不带 localRepo 的 profile 中，.work/ 下的仓库照常读不到
    const plain = await sh(`git ls-remote ${q(own)}`);
    expect(plain.code).not.toBe(0);
  });
});
