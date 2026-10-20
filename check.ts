import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import lockfile from 'proper-lockfile';

// pnpm check：完整的基础档（typecheck、lint、test、e2e）。全机同一时间只运行一份：开始前获取 WFD_TEST_LOCK
// （默认主仓库的 .work/locks/basic-tier.lock，各 worktree 由 git 的公共目录找到同一个主仓库），拿不到时等待。
// 结束时（通过或某一步失败）由这里释放锁：execa 带的 signal-exit 让 proper-lockfile 自己的退出处理不再执行。
// 进程被信号结束（Ctrl+C、kill）时锁留下，在 stale 时间（30 秒）后过期，等待的一份随后获取
const root = import.meta.dirname;
const { stdout: commonDir } = await execa('git', [
  '-C',
  root,
  'rev-parse',
  '--path-format=absolute',
  '--git-common-dir',
]);
const lockPath =
  process.env.WFD_TEST_LOCK ??
  path.join(path.dirname(commonDir.trim()), '.work', 'locks', 'basic-tier.lock');
fs.mkdirSync(path.dirname(lockPath), { recursive: true });
const options = { lockfilePath: lockPath, realpath: false, stale: 30_000 } as const;

const load = () =>
  os
    .loadavg()
    .map((n) => n.toFixed(2))
    .join(' ');

if (await lockfile.check(lockPath, options)) {
  console.log(`等待另一份基础档结束（${lockPath}）`);
}
const release = await lockfile.lock(lockPath, {
  ...options,
  retries: { forever: true, minTimeout: 2_000, maxTimeout: 5_000 },
});
console.log(`已获取 ${lockPath}`);

// 每 5 秒取一次：
// - 系统的 1 分钟 load average 与空闲内存（vm.page_free_count，即 vm_stat 的 Pages free）。系统 load 还含 macOS
//   与其他程序的后台活动（W92 实测测试只有 0–1 个线程运行时系统 load 也会升 5），照实报告；
// - 测试自身的 load：用 ps -AM 数这一步的进程树中处于 R（运行或等待 CPU）状态的线程，按 1 分钟 load average 的
//   算法（每 5 秒衰减 e^(-5/60)）累积。上限是每一步不超过 4；
// - 进程树之外 R 线程最多的 3 个进程（系统 load 高时是谁）。
// 记下每一步中两种 load 的最高值与空闲内存的最低值；每次的取值连同当时的步骤写进 .work/check-load.log。
// 基线是开始第一步之前的系统 1 分钟 load average
const pageSize = Number((await execa('sysctl', ['-n', 'hw.pagesize'])).stdout);
const freeMb = async () =>
  (Number((await execa('sysctl', ['-n', 'vm.page_free_count'])).stdout) * pageSize) / 2 ** 20;
const loadLog = path.join(root, '.work', 'check-load.log');
fs.mkdirSync(path.dirname(loadLog), { recursive: true });
fs.writeFileSync(loadLog, '');
const DECAY = Math.exp(-5 / 60);

// 这一步的进程树中 R 状态的线程数，与树之外 R 线程最多的 3 个进程（名字与线程数）
async function runningThreads(stepPid: number | undefined) {
  const { stdout } = await execa('ps', ['-AM', '-o', 'pid,ppid,state']);
  const parent = new Map<number, number>();
  const running = new Map<number, number>();
  // 每行（进程与它的每个线程）最后三列是 pid、ppid、state
  for (const line of stdout.split('\n').slice(1)) {
    const [pid, ppid, state] = line.trim().split(/\s+/).slice(-3);
    parent.set(Number(pid), Number(ppid));
    if (state?.startsWith('R') === true)
      running.set(Number(pid), (running.get(Number(pid)) ?? 0) + 1);
  }
  const inTree = (pid: number) => {
    for (let p: number | undefined = pid; p !== undefined && p > 1; p = parent.get(p))
      if (p === stepPid) return true;
    return false;
  };
  let own = 0;
  const others: [number, number][] = [];
  for (const [pid, n] of running) {
    if (inTree(pid)) own += n;
    else others.push([pid, n]);
  }
  const top = others.sort((a, b) => b[1] - a[1]).slice(0, 3);
  const names =
    top.length === 0
      ? new Map<number, string>()
      : new Map(
          (
            await execa('ps', ['-o', 'pid=,comm=', '-p', top.map(([p]) => String(p)).join(',')], {
              // 取样到这里之间退出了的进程不再列出，ps 以 1 退出
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
    others: top.map(([pid, n]) => `${names.get(pid) ?? String(pid)}×${String(n)}`).join(','),
  };
}

let current = '开始之前';
let stepPid: number | undefined;
let peak = 0;
let ownLoad = 0;
let ownPeak = 0;
let minFree = Infinity;
let sampling = false;
setInterval(() => {
  // 上一次还没有取完时跳过这一次
  if (sampling) return;
  sampling = true;
  const now = os.loadavg()[0] ?? 0;
  peak = Math.max(peak, now);
  void (async () => {
    const threads = await runningThreads(stepPid);
    ownLoad = ownLoad * DECAY + threads.own * (1 - DECAY);
    ownPeak = Math.max(ownPeak, ownLoad);
    const mb = await freeMb();
    minFree = Math.min(minFree, mb);
    fs.appendFileSync(
      loadLog,
      `${new Date().toISOString()} ${current} 系统 ${now.toFixed(2)} 测试自身 ${ownLoad.toFixed(2)}（R 线程 ${String(threads.own)}）空闲 ${mb.toFixed(0)} MB 其他 ${threads.others}\n`,
    );
    sampling = false;
  })();
}, 5_000).unref();

const baseline = os.loadavg()[0] ?? 0;
console.log(
  `基线：1 分钟 load average ${baseline.toFixed(2)}，空闲内存 ${(await freeMb()).toFixed(0)} MB`,
);
// 两步之间等上一步的负载回落（1 分钟 load average 不超过基线 + 1），不让两步的负载叠在一起；
// 机器上别的程序让 load 一直降不下来时最多等 2 分钟
const COOL_DOWN_MS = 120_000;
async function coolDown() {
  current = '等负载回落';
  const t = Date.now();
  while ((os.loadavg()[0] ?? 0) > baseline + 1 && Date.now() - t < COOL_DOWN_MS)
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  console.log(
    `等负载回落 ${String(Math.round((Date.now() - t) / 1000))} 秒，load average ${load()}`,
  );
}
const rows: string[] = [];
const started = Date.now();
try {
  for (const [i, step] of ['typecheck', 'lint', 'test', 'e2e'].entries()) {
    if (i > 0) await coolDown();
    current = step;
    const t = Date.now();
    peak = 0;
    ownPeak = 0;
    minFree = Infinity;
    console.log(`\n=== pnpm ${step} 开始，load average ${load()}`);
    const child = execa('pnpm', [step], { cwd: root, stdio: 'inherit' });
    stepPid = child.pid;
    await child;
    stepPid = undefined;
    const row = `${step}：${String(Math.round((Date.now() - t) / 1000))} 秒，测试自身的 load 最高 ${ownPeak.toFixed(2)}，系统 1 分钟 load average 最高 ${peak.toFixed(2)}（基线 + ${(peak - baseline).toFixed(2)}），空闲内存最低 ${minFree.toFixed(0)} MB`;
    rows.push(row);
    console.log(`=== pnpm ${step} 通过，${row}（${String(os.availableParallelism())} 核）`);
  }
} finally {
  await release();
}
console.log(`\n基础档全部通过，${String(Math.round((Date.now() - started) / 1000))} 秒`);
console.log(`基线 load average ${baseline.toFixed(2)}`);
for (const row of rows) console.log(row);
