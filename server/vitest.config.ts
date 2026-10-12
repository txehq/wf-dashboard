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
  'test/live/live-trust.test.ts',
  'test/live/live-simulated.test.ts',
  'test/insights-engines.test.ts',
  'test/bindings-build.test.ts',
];

// 慢档（pnpm test:slow）：不调用真实模型、claude 与 Codex，但单个文件要一分钟以上的测试
// （在起始仓库上 npm ci 并运行隐藏测试、评分 sandbox 的时限），与基础档相同地拦截真实调用
export const slowTests = [
  'test/ic-tasks.test.ts',
  'test/grading/isolation.test.ts',
  'test/grading/ic-grade.test.ts',
];

// *.external.test.ts 会在 Linear 中建工单，只由 test:external 运行
const external = 'test/**/*.external.test.ts';

export default defineConfig({
  test: {
    // 测试进程的数据目录在 .work/test-data/<进程号>/；运行前后检查仓库根目录的 data/ 没有新增。
    // github-guard：gh 在 GitHub 上创建或修改对象的命令一律报错（测试只读取 GitHub）
    setupFiles: ['test/setup/data-dir.ts'],
    globalSetup: ['test/setup/data-guard.ts', 'test/setup/github-guard.ts'],
    projects: [
      {
        // 基础档（pnpm test）：会报错的 claude 与 codex、指向不存在域名的 gateway（test/setup/basic-tier.ts）
        extends: true,
        test: {
          name: 'local',
          include: ['test/**/*.test.ts'],
          exclude: [external, ...gatewayTests, ...slowTests],
          setupFiles: ['test/setup/basic-tier-setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'slow',
          include: slowTests,
          setupFiles: ['test/setup/basic-tier-setup.ts'],
        },
      },
      {
        extends: true,
        test: {
          name: 'gateway',
          include: gatewayTests,
          exclude: [external],
          fileParallelism: false,
        },
      },
    ],
  },
});
