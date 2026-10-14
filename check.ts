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

// 每 5 秒取一次 1 分钟的 load average，记下每一步中的最大值
let peak = 0;
setInterval(() => {
  peak = Math.max(peak, os.loadavg()[0] ?? 0);
}, 5_000).unref();

const started = Date.now();
try {
  for (const step of ['typecheck', 'lint', 'test', 'e2e']) {
    const t = Date.now();
    peak = 0;
    console.log(`\n=== pnpm ${step} 开始，load average ${load()}`);
    await execa('pnpm', [step], { cwd: root, stdio: 'inherit' });
    console.log(
      `=== pnpm ${step} 通过，${String(Math.round((Date.now() - t) / 1000))} 秒，load average ${load()}，其间 1 分钟 load average 最高 ${peak.toFixed(2)}（${String(os.availableParallelism())} 核）`,
    );
  }
} finally {
  await release();
}
console.log(`\n基础档全部通过，${String(Math.round((Date.now() - started) / 1000))} 秒`);
