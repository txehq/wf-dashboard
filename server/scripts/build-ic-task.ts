import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { config } from '../src/config.js';
import {
  applyReference,
  checkoutStartRepo,
  installDependencies,
  manifestFromRun,
  placeHiddenTests,
  runHiddenTestCases,
  scoreAgainstManifest,
} from '../src/tasks/ic.js';
import { parseTaskYaml, serializeTask, taskYamlPath } from '../src/tasks/loader.js';
import type { IcTask } from '../src/tasks/schema.js';

// 用法：tsx scripts/build-ic-task.ts <task id>
// 把 .work/ic-src/<id>/ 提交为起始仓库并打成 tasks/<id>/repo.bundle，
// 在参考实现上运行隐藏测试生成清单，写回 task.yaml，再确认起始仓库上隐藏测试有失败。

const id = process.argv[2];
if (!id) throw new Error('用法：build-ic-task.ts <task id>');

const workDir = path.join(config.repoRoot, '.work');
const srcDir = path.join(workDir, 'ic-src', id);
const buildDir = path.join(workDir, 'ic-build', id);
const taskDir = path.join(config.tasksDir, id);
const yamlFile = taskYamlPath(config.tasksDir, id);

// 固定作者与时间，同样的源文件总是得到同样的 commit
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Acme Developer',
  GIT_AUTHOR_EMAIL: 'dev@acme.example',
  GIT_AUTHOR_DATE: '2026-10-01T09:00:00Z',
  GIT_COMMITTER_NAME: 'Acme Developer',
  GIT_COMMITTER_EMAIL: 'dev@acme.example',
  GIT_COMMITTER_DATE: '2026-10-01T09:00:00Z',
};

function run(command: string, args: string[], cwd: string) {
  const proc = spawnSync(command, args, { cwd, encoding: 'utf8', env: gitEnv });
  if (proc.error) throw proc.error;
  if (proc.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 退出码 ${String(proc.status)}\n${proc.stderr}`);
  }
  return proc.stdout.trim();
}

// 1. 锁定依赖版本
if (!existsSync(path.join(srcDir, 'package-lock.json'))) {
  run('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], srcDir);
}

// 2. 提交起始仓库并打包
const repoDir = path.join(buildDir, 'repo');
rmSync(buildDir, { recursive: true, force: true });
mkdirSync(repoDir, { recursive: true });
cpSync(srcDir, repoDir, {
  recursive: true,
  filter: (source) => !source.split(path.sep).includes('node_modules'),
});
run('git', ['init', '--quiet', '--initial-branch=main'], repoDir);
run('git', ['add', '--all'], repoDir);
run('git', ['commit', '--quiet', '--message', 'Initial import'], repoDir);
const commit = run('git', ['rev-parse', 'HEAD'], repoDir);
const bundle = path.join(taskDir, 'repo.bundle');
rmSync(bundle, { force: true });
run('git', ['bundle', 'create', '--quiet', bundle, 'main'], repoDir);

// 3. 参考实现上运行隐藏测试，生成清单
const definition = parseTaskYaml(readFileSync(yamlFile, 'utf8'), yamlFile);
if (definition.kind !== 'ic') throw new Error(`${id} 不是 ic task`);
const task: IcTask = { ...definition, repo: { ...definition.repo, commit }, dir: taskDir };
const referenceCheckout = path.join(buildDir, 'reference');
checkoutStartRepo(task, referenceCheckout);
installDependencies(referenceCheckout);
applyReference(task, referenceCheckout);
// 仓库自己的测试在参考实现上也通过
run('npm', ['test'], referenceCheckout);
const scripts = z
  .object({ scripts: z.record(z.string(), z.string()) })
  .parse(JSON.parse(readFileSync(path.join(referenceCheckout, 'package.json'), 'utf8'))).scripts;
if ('typecheck' in scripts) run('npm', ['run', 'typecheck'], referenceCheckout);
placeHiddenTests(task, referenceCheckout);
const referenceRun = await runHiddenTestCases(
  task,
  referenceCheckout,
  path.join(buildDir, 'junit', 'reference.xml'),
);
const manifest = manifestFromRun(referenceRun);
const updated = {
  ...definition,
  repo: task.repo,
  hiddenTests: { ...definition.hiddenTests, manifest },
};
writeFileSync(yamlFile, serializeTask(updated));

// 4. 起始仓库上必须有失败
const startCheckout = path.join(buildDir, 'start');
checkoutStartRepo(task, startCheckout);
installDependencies(startCheckout);
// 起始仓库自己的测试是绿的，CI 在 main 上通过
run('npm', ['test'], startCheckout);
placeHiddenTests(task, startCheckout);
const startRun = await runHiddenTestCases(
  task,
  startCheckout,
  path.join(buildDir, 'junit', 'start.xml'),
);
const startScore = scoreAgainstManifest(startRun, manifest);
if (startScore.passed === startScore.declared) {
  throw new Error(`${id} 的起始仓库通过了全部隐藏测试`);
}

console.log(
  JSON.stringify(
    {
      id,
      commit,
      bundle: path.relative(config.repoRoot, bundle),
      declared: startScore.declared,
      referencePassed: referenceRun.cases.length,
      startPassed: startScore.passed,
      startFileErrors: startRun.fileErrors.length,
    },
    null,
    2,
  ),
);
