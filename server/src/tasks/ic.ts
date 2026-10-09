import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parse as parseJUnit, type TestCase, type TestSuite, type TestSuites } from 'junit2json';
import { quote } from 'shell-quote';
import type { IcTask } from './schema.js';

// 隐藏测试在 checkout 中的位置，与 task 的测试命令一致
export const hiddenTestsTarget = 'test/hidden';

function run(command: string, args: string[], cwd: string) {
  const proc = spawnSync(command, args, { cwd, encoding: 'utf8' });
  if (proc.error) throw proc.error;
  if (proc.status !== 0) {
    throw new Error(
      `${command} ${args.join(' ')} 退出码 ${String(proc.status)}\n${proc.stdout}\n${proc.stderr}`,
    );
  }
  return proc.stdout.trim();
}

// 从 task 的 git bundle clone 起始仓库并停在固定 commit
export function checkoutStartRepo(task: IcTask, dest: string) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(path.dirname(dest), { recursive: true });
  run('git', ['clone', '--quiet', '--no-checkout', path.join(task.dir, task.repo.path), dest], '.');
  run('git', ['checkout', '--quiet', '--detach', task.repo.commit], dest);
  const head = run('git', ['rev-parse', 'HEAD'], dest);
  if (head !== task.repo.commit) throw new Error(`checkout 停在 ${head}，期望 ${task.repo.commit}`);
  return head;
}

export function installDependencies(checkout: string) {
  run('npm', ['ci', '--no-audit', '--no-fund'], checkout);
}

export function placeHiddenTests(task: IcTask, checkout: string) {
  const target = path.join(checkout, hiddenTestsTarget);
  rmSync(target, { recursive: true, force: true });
  cpSync(path.join(task.dir, task.hiddenTests.dir), target, { recursive: true });
}

// 参考实现以文件形式存放在 tasks/<id>/reference/，目录结构与仓库一致，覆盖到 checkout 上
export function applyReference(task: IcTask, checkout: string) {
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
  // 无法加载的测试文件在 JUnit 中只有一条 name 与 classname 相同的 testcase
  fileErrors: { file: string; message: string }[];
}

// 根元素是 <testsuites> 或单个 <testsuite>
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

// 运行 task 的测试命令（vitest 有失败测试时退出码为 1，属于正常结果），解析 JUnit XML
export async function runHiddenTestCases(
  task: IcTask,
  checkout: string,
  junitPath: string,
): Promise<HiddenRun> {
  rmSync(junitPath, { force: true });
  mkdirSync(path.dirname(junitPath), { recursive: true });
  const command = task.hiddenTests.command.replaceAll('{junitPath}', quote([junitPath]));
  const proc = spawnSync(command, { cwd: checkout, shell: true, encoding: 'utf8' });
  if (proc.error) throw proc.error;
  if (proc.status !== 0 && proc.status !== 1) {
    throw new Error(`${command} 退出码 ${String(proc.status)}\n${proc.stdout}\n${proc.stderr}`);
  }
  const report = await parseJUnit(readFileSync(junitPath, 'utf8'));
  if (!report) throw new Error(`${junitPath} 是空的 JUnit 报告`);
  const cases: HiddenCase[] = [];
  const fileErrors: HiddenRun['fileErrors'] = [];
  for (const c of suitesOf(report).flatMap((s) => s.testcase ?? [])) {
    const file = c.classname ?? '';
    const name = c.name ?? '';
    const { outcome, message } = outcomeOf(c);
    if (name === file) fileErrors.push({ file, message: message ?? '' });
    else cases.push({ file, name, outcome, message });
  }
  return { exitCode: proc.status, cases, fileErrors };
}

// 在参考实现上运行得到的清单：必须全部通过，否则参考实现本身有问题
export function manifestFromRun(result: HiddenRun): Record<string, string[]> {
  const bad = [
    ...result.fileErrors.map((e) => `${e.file}: ${e.message}`),
    ...result.cases
      .filter((c) => c.outcome !== 'passed')
      .map((c) => `${c.file} > ${c.name}: ${c.outcome} ${c.message ?? ''}`),
  ];
  if (bad.length > 0) throw new Error(`参考实现上有未通过的隐藏测试：\n${bad.join('\n')}`);
  const manifest: Record<string, string[]> = {};
  for (const c of result.cases) (manifest[c.file] ??= []).push(c.name);
  return manifest;
}

export interface ManifestScore {
  declared: number;
  passed: number;
  outcomes: { file: string; name: string; outcome: CaseOutcome | 'not-run' }[];
}

// 分母取清单：文件无法加载时 XML 中缺少的测试记为 not-run
export function scoreAgainstManifest(
  result: HiddenRun,
  manifest: Record<string, string[]>,
): ManifestScore {
  const seen = new Map(result.cases.map((c) => [`${c.file}\0${c.name}`, c.outcome]));
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
