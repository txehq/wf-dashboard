import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

// 真实档（pnpm test:real）：真实调用 gateway 模型、claude 或 Codex 的测试，在单独的项目中逐个文件顺序执行，
// 降低对 gateway 的并发；其余测试是基础档（pnpm test，照常并行）与慢档。gateway 的错误不重试（Contracts 4），
// 挂起的请求 10 分钟后以超时错误失败
export const gatewayTests = [
  'test/environment.test.ts',
  'test/linear-reconnect.test.ts',
  'test/llm.test.ts',
  'test/tasks-api.test.ts',
  'test/variants.test.ts',
  'test/variants-import.test.ts',
  'test/grading/lfg-judge.test.ts',
  'test/runs/simulated-user.test.ts',
  'test/tasks/linear-import.test.ts',
  'test/tasks/criteria-draft.test.ts',
  'test/grading/ic-criteria-judge.test.ts',
  'test/live/live.test.ts',
  // resume 前同步 variant 中较早的一份（Contracts 14.5）
  'test/live/live-resume-sync.test.ts',
  'test/live/live-trust.test.ts',
  'test/live/live-simulated.test.ts',
  // 自有管理器构建的 variant 在 Live 中启动真实的 claude（Contracts 18.6）
  'test/live/live-own.test.ts',
  'test/insights-engines.test.ts',
  'test/bindings-build.test.ts',
  // 唯一一次真实调用 Codex（Contracts 17.5）
  'test/drafts/drafts-codex.test.ts',
  // 交给 Codex 优化的会话在分析目录中写一行（Contracts 19.3），一次 Codex 调用
  'test/insights/optimize-codex.test.ts',
  // Magi Agent 的注入与 resume（Contracts 23.3、23.4）：Claude Code 与 Codex 各两问
  'test/magi/magi-real.test.ts',
];

// 同样属于真实档：读取真实 GitHub（只读）的测试。基础档不依赖网络，其中的 gh 一律报错
export const githubReadTests = [
  'test/tasks/repo-bundle.test.ts',
  'test/github-pr.test.ts',
  'test/runs/friction.test.ts',
];

// 慢档（pnpm test:slow）：不调用真实模型、claude 与 Codex，但单个文件要一分钟以上的测试
// （在起始仓库上 npm ci 并运行隐藏测试、评分 sandbox 的时限），与基础档相同地拦截真实调用
export const slowTests = [
  'test/ic-tasks.test.ts',
  'test/grading/isolation.test.ts',
  'test/grading/ic-grade.test.ts',
  // 保存 Codex 草稿时的真实构建（wf guard、build-local、安装）
  'test/drafts/drafts-save.test.ts',
];

// *.external.test.ts 会在 Linear 中建工单，只由 test:external 运行
const external = 'test/**/*.external.test.ts';

export default defineConfig({
  test: {
    // 同时运行的测试文件最多为本机核数的一半：许多文件还会启动 git、npm、wf 等子进程，默认的核数减一会让机器过载
    maxWorkers: Math.max(1, Math.floor(availableParallelism() / 2)),
    // 测试进程的数据目录在 .work/test-data/<进程号>/；运行前后检查仓库根目录的 data/ 没有新增。
    // github-guard：gh 在 GitHub 上创建或修改对象的命令一律报错（测试只读取 GitHub）
    setupFiles: ['test/setup/data-dir.ts'],
    globalSetup: ['test/setup/data-guard.ts', 'test/setup/github-guard.ts'],
    projects: [
      {
        // 基础档（pnpm test）：会报错的 claude、codex 与 gh，指向不存在域名的 gateway（test/setup/basic-tier.ts）
        extends: true,
        test: {
          name: 'local',
          include: ['test/**/*.test.ts'],
          exclude: [external, ...gatewayTests, ...githubReadTests, ...slowTests],
          setupFiles: ['test/setup/basic-tier-setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'slow',
          include: slowTests,
          setupFiles: ['test/setup/slow-tier-setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'gateway',
          include: [...gatewayTests, ...githubReadTests],
          exclude: [external],
          fileParallelism: false,
        },
      },
    ],
  },
});
