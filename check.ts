import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import lockfile from 'proper-lockfile';

// pnpm check: typecheck, lint and vitest, all three at the same time (Contracts 38.2). Only one check runs on the machine
// at a time: it takes .work/locks/basic-tier.lock in the main repository first (every worktree finds the same main
// repository through git's common dir) and waits if it is held.
// On finish (pass or a failed step) the lock is released here: the signal-exit bundled with execa keeps proper-lockfile's own exit handler from running.
// If the process is killed by a signal (Ctrl+C, kill) the lock stays and expires after the stale time (30 s); a waiting run then takes it
const root = import.meta.dirname;
const { stdout: commonDir } = await execa('git', [
  '-C',
  root,
  'rev-parse',
  '--path-format=absolute',
  '--git-common-dir',
]);
const lockPath = path.join(path.dirname(commonDir.trim()), '.work', 'locks', 'basic-tier.lock');
fs.mkdirSync(path.dirname(lockPath), { recursive: true });
const options = { lockfilePath: lockPath, realpath: false, stale: 30_000 } as const;

const load = () =>
  os
    .loadavg()
    .map((n) => n.toFixed(2))
    .join(' ');

if (await lockfile.check(lockPath, options)) {
  console.log(`Waiting for another pnpm check to finish (${lockPath})`);
}
const release = await lockfile.lock(lockPath, {
  ...options,
  retries: { forever: true, minTimeout: 2_000, maxTimeout: 5_000 },
});
console.log(`Acquired ${lockPath}`);

const steps = ['typecheck', 'lint', 'test'] as const;
type Step = (typeof steps)[number];

// Sampled every 5 seconds:
// - the system 1-minute load average and free memory (vm.page_free_count, i.e. vm_stat's Pages free). System load also
//   includes background activity of macOS and other programs (in W92 it rose by 5 with only 0-1 test threads running); reported as is;
// - each step's own load: ps -AM counts threads in state R (running or waiting for CPU) in that step's process tree,
//   accumulated like the 1-minute load average (decay e^(-5/60) every 5 s). The three steps run together, so their
//   sum is what the machine carries;
// - the 3 processes outside the three trees with the most R threads (who is behind a high system load).
// The run records each step's own peak, the peak of their sum, and the lowest free memory; every sample goes to .work/check-load.log.
// The baseline is the system 1-minute load average before the steps start
const pageSize = Number((await execa('sysctl', ['-n', 'hw.pagesize'])).stdout);
const freeMb = async () =>
  (Number((await execa('sysctl', ['-n', 'vm.page_free_count'])).stdout) * pageSize) / 2 ** 20;
const loadLog = path.join(root, '.work', 'check-load.log');
fs.mkdirSync(path.dirname(loadLog), { recursive: true });
fs.writeFileSync(loadLog, '');
const DECAY = Math.exp(-5 / 60);

// R-state threads in each step's process tree, and the 3 processes outside them with the most R threads (name and count)
async function runningThreads(pids: Map<Step, number>) {
  const { stdout } = await execa('ps', ['-AM', '-o', 'pid,ppid,state']);
  const parent = new Map<number, number>();
  const running = new Map<number, number>();
  // The last three columns of each line (a process and each of its threads) are pid, ppid, state
  for (const line of stdout.split('\n').slice(1)) {
    const [pid, ppid, state] = line.trim().split(/\s+/).slice(-3);
    parent.set(Number(pid), Number(ppid));
    if (state?.startsWith('R') === true)
      running.set(Number(pid), (running.get(Number(pid)) ?? 0) + 1);
  }
  const stepOf = (pid: number) => {
    for (let p: number | undefined = pid; p !== undefined && p > 1; p = parent.get(p))
      for (const [step, stepPid] of pids) if (p === stepPid) return step;
    return undefined;
  };
  const own = new Map<Step, number>();
  const others: [number, number][] = [];
  for (const [pid, n] of running) {
    const step = stepOf(pid);
    if (step === undefined) others.push([pid, n]);
    else own.set(step, (own.get(step) ?? 0) + n);
  }
  const top = others.sort((a, b) => b[1] - a[1]).slice(0, 3);
  const names =
    top.length === 0
      ? new Map<number, string>()
      : new Map(
          (
            await execa('ps', ['-o', 'pid=,comm=', '-p', top.map(([p]) => String(p)).join(',')], {
              // Processes that exited since sampling are not listed, and ps exits with 1
              reject: false,
            })
          ).stdout
            .split('\n')
            .filter((l) => l.trim() !== '')
            .map((l) => {
              const [pid, ...comm] = l.trim().split(/\s+/);
              return [Number(pid), path.basename(comm.join(' '))] as const;
            }),
        );
  return {
    own,
    others: top.map(([pid, n]) => `${names.get(pid) ?? String(pid)}x${String(n)}`).join(','),
  };
}

const pids = new Map<Step, number>();
const ownLoad = new Map<Step, number>(steps.map((step) => [step, 0]));
const ownPeak = new Map<Step, number>(steps.map((step) => [step, 0]));
let peak = 0;
let totalPeak = 0;
let minFree = Infinity;
let sampling = false;
const sampler = setInterval(() => {
  // Skip this sample while the previous one is still running
  if (sampling) return;
  sampling = true;
  const now = os.loadavg()[0] ?? 0;
  peak = Math.max(peak, now);
  void (async () => {
    const threads = await runningThreads(pids);
    let total = 0;
    for (const step of steps) {
      const value = (ownLoad.get(step) ?? 0) * DECAY + (threads.own.get(step) ?? 0) * (1 - DECAY);
      ownLoad.set(step, value);
      ownPeak.set(step, Math.max(ownPeak.get(step) ?? 0, value));
      total += value;
    }
    totalPeak = Math.max(totalPeak, total);
    const mb = await freeMb();
    minFree = Math.min(minFree, mb);
    const own = steps.map((step) => `${step} ${(ownLoad.get(step) ?? 0).toFixed(2)}`).join(' ');
    fs.appendFileSync(
      loadLog,
      `${new Date().toISOString()} system ${now.toFixed(2)} own ${own} total ${total.toFixed(2)} free ${mb.toFixed(0)} MB others ${threads.others}\n`,
    );
    sampling = false;
  })();
}, 5_000);
sampler.unref();

const baseline = os.loadavg()[0] ?? 0;
console.log(
  `Baseline: 1-minute load average ${baseline.toFixed(2)}, free memory ${(await freeMb()).toFixed(0)} MB, ${String(os.availableParallelism())} cores`,
);
console.log(`Running ${steps.join(', ')} together`);

// Each step's output is collected and printed when it ends, so three streams do not interleave; it is also kept in
// .work/check/<step>.log. A failing step does not stop the others: every failure is reported in one place at the end
const logDir = path.join(root, '.work', 'check');
fs.mkdirSync(logDir, { recursive: true });
const started = Date.now();
const results = await Promise.all(
  steps.map(async (step) => {
    const t = Date.now();
    const child = execa('pnpm', [step], { cwd: root, all: true, reject: false });
    const { pid } = child;
    if (pid === undefined) throw new Error(`pnpm ${step} did not start`);
    pids.set(step, pid);
    const result = await child;
    pids.delete(step);
    const seconds = Math.round((Date.now() - t) / 1000);
    const output = result.all;
    fs.writeFileSync(path.join(logDir, `${step}.log`), output);
    console.log(
      `\n=== pnpm ${step} ${result.exitCode === 0 ? 'passed' : 'FAILED'} in ${String(seconds)} s\n${output}`,
    );
    return { step, seconds, failed: result.exitCode !== 0 };
  }),
);
await release();

const total = Math.round((Date.now() - started) / 1000);
const failed = results.filter((r) => r.failed);
console.log(`\n${failed.length === 0 ? 'Check passed' : 'Check FAILED'} in ${String(total)} s`);
console.log(
  `Load: baseline ${baseline.toFixed(2)}, system 1-minute load average peak ${peak.toFixed(2)} (baseline + ${(peak - baseline).toFixed(2)}), own load peak of the three together ${totalPeak.toFixed(2)}, lowest free memory ${minFree.toFixed(0)} MB`,
);
for (const { step, seconds, failed: stepFailed } of results)
  console.log(
    `${step}: ${String(seconds)} s, own load peak ${(ownPeak.get(step) ?? 0).toFixed(2)}${stepFailed ? ', FAILED' : ''} (${path.relative(root, path.join(logDir, `${step}.log`))})`,
  );
console.log(`Load average now ${load()}`);
if (failed.length > 0) process.exitCode = 1;
