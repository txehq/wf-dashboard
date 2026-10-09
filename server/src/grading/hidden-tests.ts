import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { parse, type TestSuite, type TestSuites } from 'junit2json';
import type { IcTask } from '../external/ic-task.js';

// 隐藏测试在 checkout 中的位置，与 Contracts 第 6 节一致
export const HIDDEN_TESTS_DEST = 'test/hidden';

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
  junitPath: string;
}

// 分母取 task 声明的清单：无法加载的文件在 JUnit 中只剩一条 name == classname 的 testcase，
// 按 XML 计数会让 agent 少建一个文件反而分母变小；清单中没有出现在 XML 里的测试记为 not-run
export function scoreJUnit(
  report: TestSuites | TestSuite,
  manifest: Record<string, string[]>,
): Pick<HiddenTestsResult, 'declared' | 'passed' | 'outcomes' | 'fileErrors'> {
  // 根元素是 <testsuite> 时 junit2json 直接返回该 suite
  const suites: TestSuite[] =
    'testcase' in report ? [report] : ((report as TestSuites).testsuite ?? []);
  const seen = new Map<string, Outcome['outcome']>();
  const fileErrors: FileError[] = [];
  for (const c of suites.flatMap((s) => s.testcase ?? [])) {
    if (c.classname === undefined || c.name === undefined) {
      throw new Error(`JUnit testcase 缺少 classname 或 name：${JSON.stringify(c)}`);
    }
    if (c.name === c.classname) {
      const message = (c.failure ?? c.error)?.[0]?.message;
      if (message === undefined) throw new Error(`文件级 testcase 没有错误信息：${c.classname}`);
      fileErrors.push({ file: c.classname, message });
      continue;
    }
    const outcome =
      c.failure !== undefined
        ? 'failed'
        : c.error !== undefined
          ? 'errored'
          : c.skipped !== undefined
            ? 'skipped'
            : 'passed';
    seen.set(`${c.classname}\0${c.name}`, outcome);
  }
  const outcomes = Object.entries(manifest).flatMap(([file, names]) =>
    names.map((name): Outcome => ({
      file,
      name,
      outcome: seen.get(`${file}\0${name}`) ?? 'not-run',
    })),
  );
  return {
    declared: outcomes.length,
    passed: outcomes.filter((o) => o.outcome === 'passed').length,
    outcomes,
    fileErrors,
  };
}

// checkout 位于 data/runs/<runId>/grading/checkout；JUnit 写到它旁边，agent 的代码无法改动评分结果
export async function runHiddenTests(checkout: string, task: IcTask): Promise<HiddenTestsResult> {
  const junitPath = path.join(path.dirname(checkout), 'junit.xml');
  const dest = path.join(checkout, HIDDEN_TESTS_DEST);
  if (fs.existsSync(dest)) throw new Error(`checkout 中已存在 ${HIDDEN_TESTS_DEST}：${dest}`);
  if (fs.existsSync(junitPath)) throw new Error(`JUnit 输出已存在：${junitPath}`);
  if (!task.hiddenTests.command.includes('{junitPath}')) {
    throw new Error(`task ${task.id} 的 hiddenTests.command 中没有 {junitPath}`);
  }

  fs.cpSync(path.join(task.dir, task.hiddenTests.dir), dest, { recursive: true });
  await execa('npm', ['ci'], { cwd: checkout });
  // 路径经环境变量传入 shell，不需要转义
  const command = task.hiddenTests.command.replaceAll('{junitPath}', '"$WF_JUNIT_PATH"');
  const run = await execa('sh', ['-c', command], {
    cwd: checkout,
    env: { WF_JUNIT_PATH: junitPath },
    reject: false,
  });
  // 有失败的测试时 vitest 退出码为 1，这是正常的评分结果
  if (run.exitCode !== 0 && run.exitCode !== 1) {
    throw new Error(`隐藏测试命令退出码 ${String(run.exitCode)}：${run.stderr}`);
  }
  if (!fs.existsSync(junitPath)) {
    throw new Error(`隐藏测试命令没有写出 JUnit（退出码 ${String(run.exitCode)}）：${run.stderr}`);
  }
  const report = await parse(fs.readFileSync(junitPath, 'utf8'));
  if (report === undefined || report === null) throw new Error(`JUnit 为空：${junitPath}`);
  const { stdout: head } = await execa('git', ['-C', checkout, 'rev-parse', 'HEAD']);
  return { ...scoreJUnit(report, task.hiddenTests.manifest), head: head.trim(), junitPath };
}
