import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { afterAll, describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { gradingSandboxProfile, runHiddenTests } from '../../src/grading/hidden-tests.js';
import { loadIcTask, syncTasks } from '../../src/tasks/loader.js';
import type { IcTask } from '../../src/tasks/schema.js';
import { buildFixtureTask, git, testRunId } from '../helpers/ic-fixture.js';
import { openTestDb } from '../stages/db.js';

const { db, close } = openTestDb();
syncTasks(db, config.tasksDir);
afterAll(close);

const realSettings = path.join(os.homedir(), '.claude/settings.json');

// 从 task 的 bundle clone 起始仓库到 data/runs/<runId>/grading/checkout，与评分时的位置相同
async function startCheckout(task: IcTask, runId: string): Promise<string> {
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
    const task = loadIcTask(db, 'ic-money-format');
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
    const result = await runHiddenTests(checkout, task);
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
    const result = await runHiddenTests(checkout, task);
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
    const result = await runHiddenTests(checkout, task);
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
});
