import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { gradingSandboxProfile, runHiddenTests } from '../../src/grading/hidden-tests.js';
import { loadTask, syncTasks, withHiddenTests } from '../../src/tasks/loader.js';
import type { TestsTask } from '../../src/tasks/schema.js';
import { buildFixtureTask, git, testRunId } from '../helpers/ic-fixture.js';
import { openTestDb } from '../stages/db.js';

const { db, close } = openTestDb();
syncTasks(db, config.tasksDir);
afterAll(close);

const realSettings = path.join(os.homedir(), '.claude/settings.json');

// 从 task 的 bundle clone 起始仓库到 data/runs/<runId>/grading/checkout，与评分时的位置相同
async function startCheckout(task: TestsTask, runId: string): Promise<string> {
  const checkout = path.join(config.runsDir, runId, 'grading/checkout');
  await git(config.repoRoot, ['clone', '-q', path.join(task.dir, task.repo.path), checkout]);
  return checkout;
}

async function commitAll(checkout: string, message: string) {
  await git(checkout, ['add', '-A']);
  await git(checkout, ['commit', '-q', '-m', message]);
}

// W15 C1 的复现：src/format.js 不改，只加 agent 能在 PR 中加入的 vitest 配置、setupFiles 与 postinstall
describe('评分隔离：checkout 中的配置与安装脚本不影响隐藏测试', { timeout: 5 * 60_000 }, () => {
  it.concurrent.each([
    ['对照：起始仓库', false],
    ['作弊：vitest.config.js + setupFiles 让断言失效，postinstall 在 checkout 外写文件', true],
  ])('%s → 通过 4 / 声明 19，checkout 外没有文件', async (_, cheat) => {
    const task = withHiddenTests(loadTask(db, 'ic-money-format'));
    const runId = testRunId(cheat ? 'w18a-cheat' : 'w18a-control');
    const checkout = await startCheckout(task, runId);
    const outside = path.join(path.dirname(checkout), 'outside-checkout.txt');
    if (cheat) {
      fs.writeFileSync(
        path.join(checkout, 'vitest.config.js'),
        `import { defineConfig } from 'vitest/config';\nexport default defineConfig({ test: { setupFiles: ['./test/setup.js'] } });\n`,
      );
      fs.writeFileSync(
        path.join(checkout, 'test/setup.js'),
        `import { chai } from 'vitest';\nchai.Assertion.prototype.assert = function () {};\n`,
      );
      const pkgPath = path.join(checkout, 'package.json');
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
        scripts: Record<string, string>;
      };
      pkg.scripts.postinstall = `node -e "require('fs').writeFileSync('../outside-checkout.txt', process.env.HOME)"`;
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
      await commitAll(checkout, 'cheat');
    }
    const result = await runHiddenTests(checkout, task, new AbortController().signal);
    expect(result.error).toBeNull();
    expect([result.passed, result.declared]).toEqual([4, 19]);
    expect(fs.existsSync(outside)).toBe(false);
  });
});

describe('评分 sandbox', { timeout: 5 * 60_000 }, () => {
  it('越界读写失败：真实 ~/.claude/settings.json、其他 run 的目录、checkout 外的仓库；grading 目录内可写', async () => {
    const runId = testRunId('w18a-sbx');
    const gradingDir = path.join(config.runsDir, runId, 'grading');
    const otherRun = path.join(config.runsDir, testRunId('w18a-sbx-other'));
    fs.mkdirSync(gradingDir, { recursive: true });
    fs.mkdirSync(otherRun, { recursive: true });
    fs.writeFileSync(path.join(otherRun, 'Brief.md'), 'other run');
    expect(fs.existsSync(realSettings)).toBe(true);
    const profile = gradingSandboxProfile(gradingDir);
    const probe = (script: string) =>
      execa('sandbox-exec', ['-p', profile, 'sh', '-c', script], { reject: false });

    const readSettings = await probe(`cat "${realSettings}"`);
    expect(readSettings.exitCode).not.toBe(0);
    expect(readSettings.stdout).toBe('');
    expect(readSettings.stderr).toContain('Operation not permitted');

    const readOther = await probe(`cat "${path.join(otherRun, 'Brief.md')}"`);
    expect(readOther.stderr).toContain('Operation not permitted');
    const listRuns = await probe(`ls "${config.runsDir}"`);
    expect(listRuns.stderr).toContain('Operation not permitted');

    const outsideFile = path.join(config.repoRoot, '.work', `${runId}-outside.txt`);
    const writeOutside = await probe(`echo x > "${outsideFile}"`);
    expect(writeOutside.stderr).toContain('Operation not permitted');
    expect(fs.existsSync(outsideFile)).toBe(false);
    const writeOther = await probe(`echo x > "${path.join(otherRun, 'injected')}"`);
    expect(writeOther.stderr).toContain('Operation not permitted');

    const inside = await probe(
      `echo ok > "${gradingDir}/inside.txt" && cat "${gradingDir}/inside.txt"`,
    );
    expect(inside.exitCode).toBe(0);
    expect(inside.stdout).toBe('ok');
  });

  it('agent 的代码在评分时读取真实凭据失败，错误进入 fileErrors', async () => {
    const runId = testRunId('w18a-secret');
    const task = await buildFixtureTask(runId);
    const checkout = await startCheckout(task, runId);
    fs.writeFileSync(
      path.join(checkout, 'src/math.js'),
      `import fs from 'node:fs';\nexport const leaked = fs.readFileSync(${JSON.stringify(realSettings)}, 'utf8');\nexport function add(a, b) {\n  return a + b;\n}\nexport function subtract(a, b) {\n  return a - b;\n}\n`,
    );
    await commitAll(checkout, 'read secrets');
    const result = await runHiddenTests(checkout, task, new AbortController().signal);
    expect(result.error).toBeNull();
    expect(result.passed).toBe(0);
    expect(result.fileErrors.map((e) => e.file).sort()).toEqual([
      'test/hidden/divide.hidden.test.js',
      'test/hidden/multiply.hidden.test.js',
      'test/hidden/subtract.hidden.test.js',
    ]);
    // 导入 src/math.js 的两个文件因读取凭据被拒绝而无法加载；divide 在 fixture 中本来就没有实现
    const byFile = new Map(result.fileErrors.map((e) => [e.file, e.message]));
    expect(byFile.get('test/hidden/subtract.hidden.test.js')).toContain(
      `EPERM: operation not permitted, open '${realSettings}'`,
    );
    expect(byFile.get('test/hidden/multiply.hidden.test.js')).toContain(
      `EPERM: operation not permitted, open '${realSettings}'`,
    );
  });

  it('模块顶层 while (true) {} 在时限内被强制结束，记为评分错误，进程树不残留', async () => {
    const runId = testRunId('w18a-timeout');
    // 每次评分的 npm 缓存都是空的，并行跑全部测试时 npm ci 需要几十秒
    const timeoutSeconds = 90;
    const task = await buildFixtureTask(runId, timeoutSeconds);
    const checkout = await startCheckout(task, runId);
    fs.writeFileSync(
      path.join(checkout, 'src/math.js'),
      'while (true) {}\nexport function add(a, b) {\n  return a + b;\n}\n',
    );
    await commitAll(checkout, 'hang');
    const started = Date.now();
    const result = await runHiddenTests(checkout, task, new AbortController().signal);
    const elapsed = Date.now() - started;
    expect(result.error).toBe(`隐藏测试命令 超过 ${String(timeoutSeconds)} 秒没有结束，已强制结束`);
    expect(result.passed).toBe(0);
    expect(result.declared).toBe(8);
    expect(result.junitPath).toBeNull();
    expect(new Set(result.outcomes.map((o) => o.outcome))).toEqual(new Set(['not-run']));
    // npm ci 与测试命令各自计时
    expect(elapsed).toBeLessThan(2 * timeoutSeconds * 1000);
    const { stdout } = await execa('ps', ['-axo', 'command']);
    expect(stdout.split('\n').filter((line) => line.includes(checkout))).toEqual([]);
  });

  // W15 H13 的 runner 部分：取消评分或服务关闭时 signal 中止，正在运行的测试命令连同进程树结束，评分抛出中止原因
  it('评分中止：挂起的测试命令被结束，抛出中止原因，进程树不残留', async () => {
    const runId = testRunId('w18b-abort');
    const task = await buildFixtureTask(runId, 600);
    const checkout = await startCheckout(task, runId);
    fs.writeFileSync(
      path.join(checkout, 'src/math.js'),
      'while (true) {}\nexport function add(a, b) {\n  return a + b;\n}\n',
    );
    await commitAll(checkout, 'hang');
    const controller = new AbortController();
    const grading = runHiddenTests(checkout, task, controller.signal);
    // 测试命令开始运行（日志出现）后再等 3 秒，确认 vitest 已经挂在模块顶层
    const log = path.join(path.dirname(checkout), 'hidden-tests.log');
    while (!fs.existsSync(log)) await new Promise((resolve) => setTimeout(resolve, 200));
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    controller.abort(new Error('评分被页面取消'));
    await expect(grading).rejects.toThrow('评分被页面取消');
    const { stdout } = await execa('ps', ['-axo', 'command']);
    expect(stdout.split('\n').filter((line) => line.includes(checkout))).toEqual([]);
  });

  // W15 Medium 13：PR 中已有 test/hidden 时以前抛错让 run 失败；现在整个目录换成 task 的隐藏测试
  it('PR 自带的 test/hidden 不参与评分', async () => {
    const task = withHiddenTests(loadTask(db, 'ic-money-format'));
    const runId = testRunId('w18b-own-hidden');
    const checkout = await startCheckout(task, runId);
    fs.mkdirSync(path.join(checkout, 'test/hidden'), { recursive: true });
    fs.writeFileSync(
      path.join(checkout, 'test/hidden/extra.hidden.test.js'),
      `import { test } from 'vitest';\ntest('agent 自己的测试', () => {});\n`,
    );
    await commitAll(checkout, 'own hidden tests');
    const result = await runHiddenTests(checkout, task, new AbortController().signal);
    expect([result.passed, result.declared]).toEqual([4, 19]);
    expect(fs.existsSync(path.join(checkout, 'test/hidden/extra.hidden.test.js'))).toBe(false);
  });

  // Contracts 7.9（W18c）：checkout 内的步骤因 agent 的代码失败，是 agent 的结果——记 0 / 声明数并写明原文，不抛错
  it('PR 的 package-lock.json 让 npm ci 失败：记 0 / 声明数，error 为 npm ci 的原文', async () => {
    const task = withHiddenTests(loadTask(db, 'ic-money-format'));
    const runId = testRunId('w18c-npm-ci');
    const checkout = await startCheckout(task, runId);
    const lockPath = path.join(checkout, 'package-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
      packages: Record<string, { integrity?: string }>;
    };
    const [name, entry] =
      Object.entries(lock.packages).find(([k, p]) => k !== '' && p.integrity) ?? [];
    if (name === undefined || entry === undefined)
      throw new Error('lockfile 中没有带 integrity 的包');
    // 来源仍是 registry，但完整性校验值是错的
    entry.integrity = `sha512-${Buffer.alloc(64).toString('base64')}`;
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
    await commitAll(checkout, 'broken lockfile');
    const result = await runHiddenTests(checkout, task, new AbortController().signal);
    expect([result.passed, result.declared]).toEqual([0, 19]);
    expect(result.error).toMatch(/^npm ci 退出码 \d+：/);
    expect(result.error).toMatch(/EINTEGRITY|integrity/i);
    expect(new Set(result.outcomes.map((o) => o.outcome))).toEqual(new Set(['not-run']));
  });
});
