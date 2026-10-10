import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { parse, type TestSuite, type TestSuites } from 'junit2json';
import treeKill from 'tree-kill';
import { z } from 'zod';
import { config } from '../config.js';
import { junitCases, placeHiddenConfig, scoreAgainstManifest } from '../tasks/ic.js';
import type { IcTask } from '../tasks/schema.js';

// 隐藏测试在 checkout 中的位置，与 Contracts 第 6 节一致
export const HIDDEN_TESTS_DEST = 'test/hidden';

// Playwright 浏览器的共享目录：dashboard 在 sandbox 之外安装，评分时只读使用
export const playwrightBrowsersDir = path.join(config.dataDir, 'playwright-browsers');

export interface Outcome {
  file: string;
  name: string;
  outcome: 'passed' | 'failed' | 'errored' | 'skipped' | 'not-run';
}

export interface FileError {
  file: string;
  message: string;
}

export interface HiddenTestsResult {
  declared: number;
  passed: number;
  outcomes: Outcome[];
  fileErrors: FileError[];
  head: string;
  // 评分错误（步骤超时、依赖来源不可信）时为 null，测试全部为 not-run
  junitPath: string | null;
  error: string | null;
}

// 分母取 task 声明的清单：无法加载的文件在 JUnit 中只剩一条 name == classname 的 testcase，
// 按 XML 计数会让 agent 少建一个文件反而分母变小；清单中没有出现在 XML 里的测试记为 not-run
export function scoreJUnit(
  report: TestSuites | TestSuite,
  manifest: Record<string, string[]>,
): Pick<HiddenTestsResult, 'declared' | 'passed' | 'outcomes' | 'fileErrors'> {
  const run = junitCases(report);
  return { ...scoreAgainstManifest(run, manifest), fileErrors: run.fileErrors };
}

// sandbox-exec 的 SBPL 字符串字面量
const literal = (value: string) => JSON.stringify(value);

// 评分 sandbox：只允许写 grading 目录；禁止读凭据、task 目录（参考实现与隐藏测试）、数据目录（其他 run、variant、
// 数据库）与 vault。越界读写返回 EPERM。工具会从 checkout 向上逐级读取 package.json 等配置文件，仓库根目录保持可读
export function gradingSandboxProfile(gradingDir: string): string {
  const home = os.homedir();
  const deniedReads = [
    ...[
      '.claude',
      '.claude.json',
      '.mcp-auth',
      '.config/gh',
      '.codex',
      '.ssh',
      '.npmrc',
      'Library/Application Support/wf',
    ].map((p) => path.join(home, p)),
    config.claudeSettingsPath,
    config.codexAuthPath,
    config.tasksDir,
    config.dataDir,
    config.dbPath,
    `${config.dbPath}-wal`,
    `${config.dbPath}-shm`,
    config.vaultDir,
  ].map((p) => path.resolve(p));
  const subpaths = (paths: string[]) => paths.map((p) => `(subpath ${literal(p)})`).join(' ');
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write* (subpath "/"))',
    `(allow file-write* ${subpaths([gradingDir])} (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/"))`,
    `(deny file-read-data ${subpaths(deniedReads)})`,
    `(allow file-read-data ${subpaths([gradingDir, path.resolve(playwrightBrowsersDir)])})`,
  ].join('\n');
}

interface Step {
  name: string;
  argv: [string, ...string[]];
  cwd: string;
  env: Record<string, string>;
  // null 时在 sandbox 之外运行，env 在 dashboard 的环境上追加（只用于 dashboard 自己的命令）
  sandbox: string | null;
  // stdout 与 stderr 追加写入的日志文件；写文件而不经过管道，强制结束后不会被残留进程挂住
  log: string;
  timeoutMs: number;
  // 取消评分或服务关闭：结束整棵进程树，抛出 signal.reason
  signal: AbortSignal;
}

interface StepResult {
  exitCode: number;
  timedOut: boolean;
}

// 超时或取消时结束整棵进程树（vitest worker、Playwright 的 webServer 与浏览器都在其中）
async function runStep(step: Step): Promise<StepResult> {
  step.signal.throwIfAborted();
  const [file, ...args] =
    step.sandbox === null
      ? step.argv
      : (['sandbox-exec', '-p', step.sandbox, ...step.argv] as const);
  const output = { file: step.log, append: true } as const;
  const child = execa(file, args, {
    cwd: step.cwd,
    env: step.env,
    extendEnv: step.sandbox === null,
    reject: false,
    stdin: 'ignore',
    stdout: output,
    stderr: output,
  });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error(`${step.name} 没有启动：${String((await child).originalMessage)}`);
  }
  const state = { timedOut: false };
  const kill = () => {
    treeKill(pid, 'SIGKILL', (error) => {
      if (error !== undefined) throw error;
    });
  };
  const timer = setTimeout(() => {
    state.timedOut = true;
    kill();
  }, step.timeoutMs);
  step.signal.addEventListener('abort', kill, { once: true });
  const result = await child;
  clearTimeout(timer);
  step.signal.removeEventListener('abort', kill);
  step.signal.throwIfAborted();
  if (state.timedOut) return { exitCode: -1, timedOut: true };
  if (result.exitCode === undefined) {
    throw new Error(`${step.name} 被信号 ${String(result.signal)} 结束：${tail(step.log)}`);
  }
  return { exitCode: result.exitCode, timedOut: false };
}

const tail = (log: string) => fs.readFileSync(log, 'utf8').slice(-4000);

const timeoutError = (step: string, seconds: number) =>
  `${step} 超过 ${String(seconds)} 秒没有结束，已强制结束`;

const PackageLock = z.object({
  packages: z.record(
    z.string(),
    z.object({
      resolved: z.string().optional(),
      integrity: z.string().optional(),
      link: z.boolean().optional(),
    }),
  ),
});

// checkout 的依赖必须全部来自 npm registry 并带完整性校验：本地目录、git 或 tarball 地址的包
// 可以把测试运行器换成 agent 自己写的实现
function untrustedDependencies(checkout: string): string[] {
  const lock = PackageLock.parse(
    JSON.parse(fs.readFileSync(path.join(checkout, 'package-lock.json'), 'utf8')),
  );
  return Object.entries(lock.packages)
    .filter(([key]) => key !== '')
    .filter(
      ([, p]) =>
        p.link === true ||
        p.integrity === undefined ||
        p.resolved?.startsWith('https://registry.npmjs.org/') !== true,
    )
    .map(([key, p]) => `${key}（${p.resolved ?? (p.link === true ? 'link' : '无 resolved')}）`);
}

const semver = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

// checkout 安装了 @playwright/test 时，由 dashboard 在 sandbox 之外按同一版本安装浏览器；版本号只取自
// package.json 的 version 字段并校验格式，安装用的是 registry 上的 playwright，不运行 checkout 中的代码
function playwrightVersion(checkout: string): string | null {
  const file = path.join(checkout, 'node_modules/@playwright/test/package.json');
  if (!fs.existsSync(file)) return null;
  const { version } = z
    .object({ version: z.string() })
    .parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!semver.test(version)) throw new Error(`@playwright/test 的版本号格式不正确：${version}`);
  return version;
}

function failedResult(task: IcTask, head: string, error: string): HiddenTestsResult {
  const outcomes = Object.entries(task.hiddenTests.manifest).flatMap(([file, names]) =>
    names.map((name): Outcome => ({ file, name, outcome: 'not-run' })),
  );
  return {
    declared: outcomes.length,
    passed: 0,
    outcomes,
    fileErrors: [],
    head,
    junitPath: null,
    error,
  };
}

// checkout 位于 data/runs/<runId>/grading/checkout。npm ci 与测试命令在 sandbox 中运行：只能写 grading 目录，
// 读不到凭据与其他 run；测试配置由 task 提供并放在 checkout 之外，JUnit 写在 checkout 之外
export async function runHiddenTests(
  checkout: string,
  task: IcTask,
  signal: AbortSignal,
): Promise<HiddenTestsResult> {
  const gradingDir = path.dirname(checkout);
  const junitPath = path.join(gradingDir, 'junit.xml');
  const dest = path.join(checkout, HIDDEN_TESTS_DEST);
  if (fs.existsSync(junitPath)) throw new Error(`JUnit 输出已存在：${junitPath}`);
  const { stdout } = await execa('git', ['-C', checkout, 'rev-parse', 'HEAD']);
  const head = stdout.trim();

  // PR 自己带的 test/hidden 不参与评分：整个目录换成 task 的隐藏测试
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(path.join(task.dir, task.hiddenTests.dir), dest, { recursive: true });
  const configPath = placeHiddenConfig(task, checkout, path.join(gradingDir, 'hidden-config'));
  // 工具向上查找 package.json 与 tsconfig.json 时停在 grading 目录，不读到 dashboard 仓库的文件（sandbox 禁止读取）：
  // 测试配置按 ES module 加载，checkout 没有 tsconfig.json 时用空配置
  fs.writeFileSync(
    path.join(gradingDir, 'package.json'),
    '{ "private": true, "type": "module" }\n',
  );
  fs.writeFileSync(path.join(gradingDir, 'tsconfig.json'), '{}\n');
  const home = path.join(gradingDir, 'home');
  const tmp = path.join(gradingDir, 'tmp');
  fs.mkdirSync(home);
  fs.mkdirSync(tmp);
  if (process.env.PATH === undefined) throw new Error('dashboard 进程没有 PATH');
  const env = {
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: tmp,
    LANG: 'en_US.UTF-8',
    PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersDir,
    WF_JUNIT_PATH: junitPath,
    WF_HIDDEN_CONFIG: configPath,
  };
  const sandbox = gradingSandboxProfile(gradingDir);
  const { timeoutSeconds } = task.hiddenTests;
  const timeoutMs = timeoutSeconds * 1000;

  const untrusted = untrustedDependencies(checkout);
  if (untrusted.length > 0) {
    return failedResult(
      task,
      head,
      `package-lock.json 中有不是来自 npm registry 的依赖，不运行隐藏测试：${untrusted.join('、')}`,
    );
  }

  const install = await runStep({
    name: 'npm ci',
    argv: ['npm', 'ci', '--ignore-scripts', '--no-audit', '--no-fund'],
    cwd: checkout,
    env,
    sandbox,
    log: path.join(gradingDir, 'npm-ci.log'),
    timeoutMs,
    signal,
  });
  if (install.timedOut) return failedResult(task, head, timeoutError('npm ci', timeoutSeconds));
  if (install.exitCode !== 0) {
    throw new Error(
      `npm ci 退出码 ${String(install.exitCode)}：${tail(path.join(gradingDir, 'npm-ci.log'))}`,
    );
  }

  const playwright = playwrightVersion(checkout);
  if (playwright !== null) {
    fs.mkdirSync(playwrightBrowsersDir, { recursive: true });
    const log = path.join(gradingDir, 'playwright-install.log');
    const browsers = await runStep({
      name: 'playwright install',
      argv: ['npx', '--yes', `playwright@${playwright}`, 'install', 'chromium'],
      cwd: playwrightBrowsersDir,
      env: { PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersDir },
      sandbox: null,
      log,
      timeoutMs,
      signal,
    });
    if (browsers.timedOut) {
      return failedResult(task, head, timeoutError('playwright install', timeoutSeconds));
    }
    if (browsers.exitCode !== 0) {
      throw new Error(`playwright install 退出码 ${String(browsers.exitCode)}：${tail(log)}`);
    }
  }

  // 路径经环境变量传入 shell，不需要转义
  const command = task.hiddenTests.command
    .replaceAll('{junitPath}', '"$WF_JUNIT_PATH"')
    .replaceAll('{configPath}', '"$WF_HIDDEN_CONFIG"');
  const log = path.join(gradingDir, 'hidden-tests.log');
  const run = await runStep({
    name: '隐藏测试命令',
    argv: ['sh', '-c', command],
    cwd: checkout,
    env,
    sandbox,
    log,
    timeoutMs,
    signal,
  });
  if (run.timedOut) return failedResult(task, head, timeoutError('隐藏测试命令', timeoutSeconds));
  // 有失败的测试时退出码为 1，这是正常的评分结果
  if (run.exitCode !== 0 && run.exitCode !== 1) {
    throw new Error(`隐藏测试命令退出码 ${String(run.exitCode)}：${tail(log)}`);
  }
  if (!fs.existsSync(junitPath)) {
    throw new Error(`隐藏测试命令没有写出 JUnit（退出码 ${String(run.exitCode)}）：${tail(log)}`);
  }
  const report = await parse(fs.readFileSync(junitPath, 'utf8'));
  if (report === undefined || report === null) throw new Error(`JUnit 为空：${junitPath}`);
  return { ...scoreJUnit(report, task.hiddenTests.manifest), head, junitPath, error: null };
}
