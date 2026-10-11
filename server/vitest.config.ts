import { defineConfig } from 'vitest/config';

// 真实调用 gateway（模型请求或 claude CLI）的测试：在单独的项目中逐个文件顺序执行，降低对 gateway 的并发；
// 其余测试照常并行。gateway 的错误不重试（Contracts 4），挂起的请求 120 秒后以超时错误失败
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
  'test/live/live-simulated.test.ts',
];

// *.external.test.ts 会在 Linear 与 txehq 中创建对象，只由 test:external 运行
const external = 'test/**/*.external.test.ts';

export default defineConfig({
  test: {
    // 测试进程的数据目录在 .work/test-data/<进程号>/；运行前后检查仓库根目录的 data/ 没有新增
    setupFiles: ['test/setup/data-dir.ts'],
    globalSetup: ['test/setup/data-guard.ts'],
    projects: [
      {
        extends: true,
        test: {
          name: 'local',
          include: ['test/**/*.test.ts'],
          exclude: [external, ...gatewayTests],
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
