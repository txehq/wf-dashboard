import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { parse, type TestSuite, type TestSuites } from 'junit2json';
import treeKill from 'tree-kill';
import { z } from 'zod';
import { config } from '../config.js';
import { junitCases, placeHiddenConfig, scoreAgainstManifest } from '../tasks/ic.js';
import type { TestsTask } from '../tasks/schema.js';

// Location of the hidden tests in the checkout, as in Contracts section 6
export const HIDDEN_TESTS_DEST = 'test/hidden';

// Shared Playwright browser directory: the dashboard installs it outside the sandbox; grading only reads it
export const playwrightBrowsersDir = config.playwrightBrowsersDir;

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
  // null on a grading error (step timeout, untrusted dependency source); all tests are then not-run
  junitPath: string | null;
  error: string | null;
}

// The denominator is the task's declared manifest: a file that fails to load leaves one testcase with name == classname in JUnit,
// so counting the XML would shrink the denominator when the agent omits a file; manifest tests missing from the XML are not-run
export function scoreJUnit(
  report: TestSuites | TestSuite,
  manifest: Record<string, string[]>,
): Pick<HiddenTestsResult, 'declared' | 'passed' | 'outcomes' | 'fileErrors'> {
  const run = junitCases(report);
  return { ...scoreAgainstManifest(run, manifest), fileErrors: run.fileErrors };
}

// SBPL string literal for sandbox-exec
const literal = (value: string) => JSON.stringify(value);

// Grading sandbox: writes only to the grading directory; no reads of credentials, the task directory (reference solution and hidden tests),
// the data directory (other runs, variants, database) or the vault. Out-of-bounds access gets EPERM. Tools read package.json etc. upward from the checkout, so the repo root stays readable
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
  // null runs outside the sandbox with env added to the dashboard's environment (only for the dashboard's own commands)
  sandbox: string | null;
  // Log file that stdout and stderr append to; a file instead of a pipe, so leftover processes cannot hang it after a kill
  log: string;
  timeoutMs: number;
  // Grading cancelled or server shutting down: kill the whole process tree and throw signal.reason
  signal: AbortSignal;
}

interface StepResult {
  exitCode: number;
  timedOut: boolean;
}

// On timeout or cancel, kill the whole process tree (vitest workers, Playwright's webServer and browsers included)
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
    throw new Error(`${step.name} did not start: ${String((await child).originalMessage)}`);
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
    throw new Error(
      `${step.name} was killed by signal ${String(result.signal)}: ${tail(step.log)}`,
    );
  }
  return { exitCode: result.exitCode, timedOut: false };
}

const tail = (log: string) => fs.readFileSync(log, 'utf8').slice(-4000);

const timeoutError = (step: string, seconds: number) =>
  `${step} did not finish within ${String(seconds)} seconds and was killed`;

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

// Every checkout dependency must come from the npm registry with an integrity hash: packages from local directories, git or tarball URLs
// could replace the test runner with the agent's own implementation
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
    .map(([key, p]) => `${key} (${p.resolved ?? (p.link === true ? 'link' : 'no resolved')})`);
}

const semver = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

// When the checkout installs @playwright/test, the dashboard installs browsers of the same version outside the sandbox; the version comes only from
// package.json's version field and is format-checked, and the install uses playwright from the registry, running no checkout code
function playwrightVersion(checkout: string): string | null {
  const file = path.join(checkout, 'node_modules/@playwright/test/package.json');
  if (!fs.existsSync(file)) return null;
  const { version } = z
    .object({ version: z.string() })
    .parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  if (!semver.test(version)) throw new Error(`Invalid @playwright/test version: ${version}`);
  return version;
}

function failedResult(task: TestsTask, head: string, error: string): HiddenTestsResult {
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

// The checkout is at data/runs/<runId>/grading/checkout. npm ci and the test command run in the sandbox: they write only the grading directory
// and cannot read credentials or other runs; the test config comes from the task and lives outside the checkout, as does the JUnit file
export async function runHiddenTests(
  checkout: string,
  task: TestsTask,
  signal: AbortSignal,
): Promise<HiddenTestsResult> {
  const gradingDir = path.dirname(checkout);
  const junitPath = path.join(gradingDir, 'junit.xml');
  const dest = path.join(checkout, HIDDEN_TESTS_DEST);
  if (fs.existsSync(junitPath)) throw new Error(`JUnit output already exists: ${junitPath}`);
  const { stdout } = await execa('git', ['-C', checkout, 'rev-parse', 'HEAD']);
  const head = stdout.trim();

  // The PR's own test/hidden is not graded: the whole directory is replaced by the task's hidden tests
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(path.join(task.dir, task.hiddenTests.dir), dest, { recursive: true });
  const configPath = placeHiddenConfig(task, checkout, path.join(gradingDir, 'hidden-config'));
  // Tools searching upward for package.json and tsconfig.json stop at the grading directory, never reaching the dashboard repo (the sandbox denies it):
  // the test config loads as an ES module, and an empty config applies when the checkout has no tsconfig.json
  fs.writeFileSync(
    path.join(gradingDir, 'package.json'),
    '{ "private": true, "type": "module" }\n',
  );
  fs.writeFileSync(path.join(gradingDir, 'tsconfig.json'), '{}\n');
  const home = path.join(gradingDir, 'home');
  const tmp = path.join(gradingDir, 'tmp');
  fs.mkdirSync(home);
  fs.mkdirSync(tmp);
  if (process.env.PATH === undefined) throw new Error('Dashboard process has no PATH');
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
      `package-lock.json has dependencies not from the npm registry, hidden tests not run: ${untrusted.join(', ')}`,
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
  // A failing step inside the checkout is the agent's result (Contracts 7.9): score 0 / declared and record the reason and raw output
  if (install.exitCode !== 0) {
    return failedResult(
      task,
      head,
      `npm ci exit code ${String(install.exitCode)}: ${tail(path.join(gradingDir, 'npm-ci.log'))}`,
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
    // Installing browsers is the dashboard's own step: failure or timeout is a grading error
    if (browsers.timedOut) throw new Error(timeoutError('playwright install', timeoutSeconds));
    if (browsers.exitCode !== 0) {
      throw new Error(`playwright install exit code ${String(browsers.exitCode)}: ${tail(log)}`);
    }
  }

  // Paths reach the shell through environment variables, so no escaping is needed
  const command = task.hiddenTests.command
    .replaceAll('{junitPath}', '"$WF_JUNIT_PATH"')
    .replaceAll('{configPath}', '"$WF_HIDDEN_CONFIG"');
  const log = path.join(gradingDir, 'hidden-tests.log');
  const run = await runStep({
    name: 'Hidden test command',
    argv: ['sh', '-c', command],
    cwd: checkout,
    env,
    sandbox,
    log,
    timeoutMs,
    signal,
  });
  if (run.timedOut)
    return failedResult(task, head, timeoutError('Hidden test command', timeoutSeconds));
  // Exit code 1 means some tests failed, a normal grading result; any other exit code, or no JUnit written (the config failed to load because of the agent's code),
  // is the agent's result
  if (run.exitCode !== 0 && run.exitCode !== 1) {
    return failedResult(
      task,
      head,
      `Hidden test command exit code ${String(run.exitCode)}: ${tail(log)}`,
    );
  }
  if (!fs.existsSync(junitPath)) {
    return failedResult(
      task,
      head,
      `Hidden test command wrote no JUnit (exit code ${String(run.exitCode)}): ${tail(log)}`,
    );
  }
  const report = await parse(fs.readFileSync(junitPath, 'utf8'));
  if (report === undefined || report === null) {
    return failedResult(task, head, `Hidden test command wrote an empty JUnit: ${tail(log)}`);
  }
  return { ...scoreJUnit(report, task.hiddenTests.manifest), head, junitPath, error: null };
}
