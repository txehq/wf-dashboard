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
import {
  parseTaskYaml,
  serializeTask,
  taskYamlPath,
  withHiddenTests,
} from '../src/tasks/loader.js';

// Usage: tsx scripts/build-ic-task.ts <task id>
// Commit .work/ic-src/<id>/ as the starting repo and bundle it as tasks/<id>/repo.bundle,
// run the hidden tests on the reference solution to build the manifest, write it back to task.yaml, then confirm hidden tests fail on the starting repo.

const id = process.argv[2];
if (!id) throw new Error('Usage: build-ic-task.ts <task id>');

const workDir = path.join(config.repoRoot, '.work');
const srcDir = path.join(workDir, 'ic-src', id);
const buildDir = path.join(workDir, 'ic-build', id);
const taskDir = path.join(config.tasksDir, id);
const yamlFile = taskYamlPath(config.tasksDir, id);

// Fixed author and time, so the same source files always give the same commit
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
    throw new Error(
      `${command} ${args.join(' ')} exit code ${String(proc.status)}\n${proc.stderr}`,
    );
  }
  return proc.stdout.trim();
}

// 1. Lock dependency versions
if (!existsSync(path.join(srcDir, 'package-lock.json'))) {
  run('npm', ['install', '--package-lock-only', '--no-audit', '--no-fund'], srcDir);
}

// 2. Commit and bundle the starting repo
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

// 3. Run the hidden tests on the reference solution to build the manifest
const definition = parseTaskYaml(readFileSync(yamlFile, 'utf8'), yamlFile);
if (definition.kind !== 'ic' || definition.repo === undefined) {
  throw new Error(`${id} is not an ic task`);
}
const task = withHiddenTests({ ...definition, repo: { ...definition.repo, commit }, dir: taskDir });
const referenceCheckout = path.join(buildDir, 'reference');
checkoutStartRepo(task, referenceCheckout);
installDependencies(referenceCheckout);
applyReference(task, referenceCheckout);
// The repo's own tests also pass on the reference solution
run('npm', ['test'], referenceCheckout);
const scripts = z
  .object({ scripts: z.record(z.string(), z.string()) })
  .parse(JSON.parse(readFileSync(path.join(referenceCheckout, 'package.json'), 'utf8'))).scripts;
if ('typecheck' in scripts) run('npm', ['run', 'typecheck'], referenceCheckout);
placeHiddenTests(task, referenceCheckout);
const referenceRun = await runHiddenTestCases(
  task,
  referenceCheckout,
  path.join(buildDir, 'hidden', 'reference'),
);
const manifest = manifestFromRun(referenceRun);
const updated = {
  ...definition,
  repo: task.repo,
  hiddenTests: { ...task.hiddenTests, manifest },
};
writeFileSync(yamlFile, serializeTask(updated));

// 4. The starting repo must have failures
const startCheckout = path.join(buildDir, 'start');
checkoutStartRepo(task, startCheckout);
installDependencies(startCheckout);
// The starting repo's own tests are green, CI passes on main
run('npm', ['test'], startCheckout);
placeHiddenTests(task, startCheckout);
const startRun = await runHiddenTestCases(
  task,
  startCheckout,
  path.join(buildDir, 'hidden', 'start'),
);
const startScore = scoreAgainstManifest(startRun, manifest);
if (startScore.passed === startScore.declared) {
  throw new Error(`The starting repo of ${id} passed all hidden tests`);
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
