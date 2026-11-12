import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { parse as parseJUnit, type TestCase, type TestSuite, type TestSuites } from 'junit2json';
import { quote } from 'shell-quote';
import type { RepoTask, TestsTask } from './schema.js';

// Where hidden tests sit in the checkout, matching the task's test command
export const hiddenTestsTarget = 'test/hidden';

function run(command: string, args: string[], cwd: string) {
  const proc = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (proc.error) throw proc.error;
  if (proc.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} exited with code ${String(proc.status)}\n${proc.stdout}\n${proc.stderr}`,
    );
  }
  return proc.stdout.trim();
}

// Clones the starting repo from the task's git bundle and stops at the fixed commit
export function checkoutStartRepo(task: RepoTask, dest: string) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(path.dirname(dest), { recursive: true });
  run('git', ['clone', '--quiet', '--no-checkout', path.join(task.dir, task.repo.path), dest], '.');
  run('git', ['checkout', '--quiet', '--detach', task.repo.commit], dest);
  const head = run('git', ['rev-parse', 'HEAD'], dest);
  if (head !== task.repo.commit) throw new Error(`checkout is at ${head}, expected ${task.repo.commit}`);
  return head;
}

export function installDependencies(checkout: string) {
  run('npm', ['ci', '--no-audit', '--no-fund'], checkout);
}

export function placeHiddenTests(task: TestsTask, checkout: string) {
  const target = path.join(checkout, hiddenTestsTarget);
  rmSync(target, { recursive: true, force: true });
  cpSync(path.join(task.dir, task.hiddenTests.dir), target, { recursive: true });
}

// The task provides the test config, placed in configDir outside the checkout; node_modules next to it points at the checkout's dependencies,
// so imports in the config (e.g. @playwright/test) resolve from the packages installed in the checkout. Returns the config file path
export function placeHiddenConfig(
  task: TestsTask,
  checkout: string,
  configDir: string,
): string {
  if (existsSync(configDir)) throw new Error(`Hidden test config directory already exists: ${configDir}`);
  mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, path.basename(task.hiddenTests.config));
  cpSync(path.join(task.dir, task.hiddenTests.config), configPath);
  symlinkSync(path.join(checkout, 'node_modules'), path.join(configDir, 'node_modules'));
  return configPath;
}

// The reference solution is stored as files in tasks/<id>/reference/ with the repo's directory layout and copied over the checkout
export function applyReference(task: RepoTask, checkout: string) {
  cpSync(path.join(task.dir, 'reference'), checkout, { recursive: true });
}

export type CaseOutcome = 'passed' | 'failed' | 'errored' | 'skipped';

export interface HiddenCase {
  file: string;
  name: string;
  outcome: CaseOutcome;
  message: string | null;
}

export interface HiddenRun {
  exitCode: number;
  cases: HiddenCase[];
  // A test file that cannot load has a single testcase in JUnit whose name equals its classname
  fileErrors: { file: string; message: string }[];
}

// The root element is <testsuites> or a single <testsuite>
function suitesOf(report: TestSuites | TestSuite): TestSuite[] {
  return 'testcase' in report ? [report] : ((report as TestSuites).testsuite ?? []);
}

function outcomeOf(c: TestCase): { outcome: CaseOutcome; message: string | null } {
  const failure = c.failure?.[0];
  if (failure) return { outcome: 'failed', message: failure.message ?? failure.inner ?? null };
  const error = c.error?.[0];
  if (error) return { outcome: 'errored', message: error.message ?? error.inner ?? null };
  if (c.skipped) return { outcome: 'skipped', message: null };
  return { outcome: 'passed', message: null };
}

// Tests in the JUnit report and files that could not load (testcases whose name equals the classname); shared by grading and manifest generation.
// Throws when classname or name is missing or a file-level error has no message
export function junitCases(report: TestSuites | TestSuite): Omit<HiddenRun, 'exitCode'> {
  const cases: HiddenCase[] = [];
  const fileErrors: HiddenRun['fileErrors'] = [];
  for (const c of suitesOf(report).flatMap((s) => s.testcase ?? [])) {
    if (c.classname === undefined || c.name === undefined) {
      throw new Error(`JUnit testcase has no classname or name: ${JSON.stringify(c)}`);
    }
    const { outcome, message } = outcomeOf(c);
    if (c.name === c.classname) {
      if (message === null) throw new Error(`File-level testcase has no error message: ${c.classname}`);
      fileErrors.push({ file: c.classname, message });
    } else {
      cases.push({ file: c.classname, name: c.name, outcome, message });
    }
  }
  return { cases, fileErrors };
}

// Runs the task's test command (vitest exits with 1 when tests fail, which is a normal result) and parses the JUnit XML;
// the JUnit report and test config are written under outDir
export async function runHiddenTestCases(
  task: TestsTask,
  checkout: string,
  outDir: string,
): Promise<HiddenRun> {
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const junitPath = path.join(outDir, 'junit.xml');
  const configPath = placeHiddenConfig(task, checkout, path.join(outDir, 'hidden-config'));
  const command = task.hiddenTests.command
    .replaceAll('{junitPath}', quote([junitPath]))
    .replaceAll('{configPath}', quote([configPath]));
  const proc = spawnSync(command, { cwd: checkout, shell: true, encoding: 'utf8' });
  if (proc.error) throw proc.error;
  if (proc.status !== 0 && proc.status !== 1) {
    throw new Error(`${command} exited with code ${String(proc.status)}\n${proc.stdout}\n${proc.stderr}`);
  }
  const report = await parseJUnit(readFileSync(junitPath, 'utf8'));
  if (!report) throw new Error(`${junitPath} is an empty JUnit report`);
  return { exitCode: proc.status, ...junitCases(report) };
}

// The manifest from a run on the reference solution: everything must pass, otherwise the reference solution itself is broken
export function manifestFromRun(result: HiddenRun): Record<string, string[]> {
  const bad = [
    ...result.fileErrors.map((e) => `${e.file}: ${e.message}`),
    ...result.cases
      .filter((c) => c.outcome !== 'passed')
      .map((c) => `${c.file} > ${c.name}: ${c.outcome} ${c.message ?? ''}`),
  ];
  if (bad.length > 0) throw new Error(`Hidden tests did not pass on the reference solution:\n${bad.join('\n')}`);
  const manifest: Record<string, string[]> = {};
  for (const c of result.cases) (manifest[c.file] ??= []).push(c.name);
  return manifest;
}

export interface ManifestScore {
  declared: number;
  passed: number;
  outcomes: { file: string; name: string; outcome: CaseOutcome | 'not-run' }[];
}

// The denominator is the manifest: tests missing from the XML because a file could not load count as not-run. Same-named tests in one file cannot be told apart, so this throws
export function scoreAgainstManifest(
  result: Pick<HiddenRun, 'cases'>,
  manifest: Record<string, string[]>,
): ManifestScore {
  const seen = new Map<string, CaseOutcome>();
  for (const c of result.cases) {
    const key = `${c.file}\0${c.name}`;
    if (seen.has(key)) throw new Error(`JUnit has tests with the same name: ${c.file} > ${c.name}`);
    seen.set(key, c.outcome);
  }
  const outcomes = Object.entries(manifest).flatMap(([file, names]) =>
    names.map((name) => ({
      file,
      name,
      outcome: seen.get(`${file}\0${name}`) ?? ('not-run' as const),
    })),
  );
  return {
    declared: outcomes.length,
    passed: outcomes.filter((o) => o.outcome === 'passed').length,
    outcomes,
  };
}
